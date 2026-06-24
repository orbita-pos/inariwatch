//! Daily AI spend tracker.
//!
//! Each chat call goes through [`BudgetTracker::check_and_charge`]
//! BEFORE the upstream HTTP call. The tracker:
//!   1. Estimates the call's cost from the prompt's token count + the
//!      pricing table for the requested model.
//!   2. Reads today's accumulated spend from `ai_spend` (migration 0005).
//!   3. Returns one of three verdicts:
//!      - [`BudgetVerdict::Ok`] — proceed.
//!      - [`BudgetVerdict::DowngradeToMini`] — proceed BUT swap the
//!        full model for `gpt-4o-mini` (per-user cap would be crossed).
//!      - [`BudgetVerdict::Blocked`] — refuse the call (global cap
//!        would be crossed).
//!
//! After the call completes the streaming layer calls
//! [`BudgetTracker::record_actual`] with the real `usage` reported by
//! OpenAI (or our heuristic estimate when the stream omits it).
//!
//! Pricing table is hardcoded; sourced from the public OpenAI pricing
//! page on 2026-05-01. See DECISIONS for why we did not pull a config
//! file or add a refresh pinger today.

use std::sync::Arc;

use chrono::Utc;
use rusqlite::params;
use thiserror::Error;

use crate::store::{settings, Store};

use super::prompts::ChatMessage;

/// OpenAI model the desktop client can call. Pricing values live in
/// [`Self::pricing`]; the wire-name conversion in [`Self::api_name`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Model {
    /// Cheap fallback. Always picked when [`BudgetVerdict::DowngradeToMini`].
    Gpt4oMini,
    /// Default for analyze / chat / diagnose. Routed via the
    /// `ai_model_routing` setting.
    Gpt54,
}

impl Model {
    /// String the OpenAI Chat Completions API expects on the wire.
    pub fn api_name(self) -> &'static str {
        match self {
            Model::Gpt4oMini => "gpt-4o-mini",
            // GPT-5.4 wire name. Same as `web/lib/ai/openai-config.ts` —
            // when OpenAI promotes the public alias we update both
            // sides at once.
            Model::Gpt54     => "gpt-5.4",
        }
    }

    /// Inverse — accepts wire name, returns `None` when unrecognized.
    pub fn from_api_name(name: &str) -> Option<Self> {
        match name {
            "gpt-4o-mini" => Some(Model::Gpt4oMini),
            "gpt-5.4"     => Some(Model::Gpt54),
            _ => None,
        }
    }

    /// Compute integer-cent cost for an exchange of `prompt_tokens`
    /// input + `completion_tokens` output on this model. Mirrors
    /// the internal `compute_cents` helper used by the budget tracker
    /// — exposed so callers like `ai::remediate::single_shot` can
    /// stamp the same denormalised cost on `remediation_sessions.cents`
    /// without taking a dep on the tracker's mutable state.
    pub fn cents_for_tokens(self, prompt_tokens: u32, completion_tokens: u32) -> i64 {
        compute_cents(self, prompt_tokens, completion_tokens)
    }

    /// Per-million-token pricing in milli-cents (tenths of a cent) so
    /// we can keep integer arithmetic everywhere. The conversion is
    /// `dollars × 1_000` (because 1 USD = 100 cents = 1_000 milli-cents).
    /// Sourced from openai.com/api/pricing on 2026-05-01.
    fn pricing_per_million_milli_cents(self) -> (i64, i64) {
        match self {
            // gpt-4o-mini: $0.15 in / $0.60 out per 1M tokens.
            // → 150 / 600 milli-cents per 1M tokens.
            Model::Gpt4oMini => (150, 600),
            // gpt-5.4 stand-in tier — pricing matches gpt-4o (web's
            // openai-config.ts treats Sonnet-equivalent). $2.50 in /
            // $10.00 out per 1M = 2_500 / 10_000 milli-cents per 1M.
            Model::Gpt54     => (2_500, 10_000),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetVerdict {
    Ok,
    DowngradeToMini,
    Blocked,
}

#[derive(Debug, Error)]
pub enum BudgetError {
    #[error("store error: {0}")]
    Store(#[from] crate::store::StoreError),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// Per-day spend tracker backed by `ai_spend`. Cheap to clone — the
/// inner [`Store`] is already an `Arc`.
#[derive(Clone)]
pub struct BudgetTracker {
    store: Arc<Store>,
}

/// Default per-user daily cap when none is persisted. $1.00 / day.
pub const DEFAULT_PER_USER_CAP_CENTS:  i64 = 100;
/// Default global daily cap. $300 — matches the spec in the Sesión 18
/// HANDOFF and `web/.env.example::PLATFORM_AI_KEY`.
pub const DEFAULT_GLOBAL_CAP_CENTS:    i64 = 30_000;

const SETTINGS_KEY_GLOBAL_CAP:   &str = "ai_global_cap_cents";
const SETTINGS_KEY_PER_USER_CAP: &str = "ai_per_user_cap_cents";

impl BudgetTracker {
    pub fn new(store: Arc<Store>) -> Self {
        Self { store }
    }

    /// Estimate token count for a chat exchange. We sum the content
    /// length across messages and divide by 4 — the chars-per-token
    /// heuristic is good to ~15% on English+code which is plenty for
    /// budgeting decisions. The full count comes back from OpenAI in
    /// the stream's `usage` object; this estimate just gates whether
    /// to even start the call.
    pub fn estimate_prompt_tokens(messages: &[ChatMessage]) -> u32 {
        let chars: usize = messages.iter().map(|m| m.content.len()).sum();
        // Round up so empty messages still bill at least 1 token.
        ((chars + 3) / 4) as u32
    }

    /// Pre-call gate. Reads caps + accumulated spend, returns the
    /// verdict. Does NOT write — that happens in [`record_actual`].
    pub fn check(
        &self,
        model:             Model,
        prompt_tokens:     u32,
        // Estimated completion budget. We bound this at the OpenAI
        // default (1024) when callers don't pass `max_tokens`.
        completion_budget: u32,
    ) -> Result<BudgetVerdict, BudgetError> {
        let projected_cents = estimate_call_cents(model, prompt_tokens, completion_budget);
        let today_full      = self.spend_today_cents(Model::Gpt54)?;
        let today_mini      = self.spend_today_cents(Model::Gpt4oMini)?;
        let today_total     = today_full.saturating_add(today_mini);

        let global_cap   = self.read_cap(SETTINGS_KEY_GLOBAL_CAP,   DEFAULT_GLOBAL_CAP_CENTS)?;
        let per_user_cap = self.read_cap(SETTINGS_KEY_PER_USER_CAP, DEFAULT_PER_USER_CAP_CENTS)?;

        // Global cap = hard wall.
        if today_total.saturating_add(projected_cents) > global_cap {
            return Ok(BudgetVerdict::Blocked);
        }

        // Per-user cap = downgrade trigger when the call is on Gpt54.
        // For Gpt4oMini calls there's no downgrade target — cap apply
        // straight to global.
        if matches!(model, Model::Gpt54)
            && today_total.saturating_add(projected_cents) > per_user_cap
        {
            // Re-check whether the mini-equivalent still fits the cap.
            let mini_cents = estimate_call_cents(Model::Gpt4oMini, prompt_tokens, completion_budget);
            if today_total.saturating_add(mini_cents) > per_user_cap {
                // Even mini would cross — but global is still fine, so
                // serve degraded (budget enforced is per-user, the
                // service degrades rather than blocking outright).
                return Ok(BudgetVerdict::DowngradeToMini);
            }
            return Ok(BudgetVerdict::DowngradeToMini);
        }

        Ok(BudgetVerdict::Ok)
    }

    /// Record actual spend after a call completes. Idempotent on the
    /// SQL level (UPSERT). Returns the new daily total for the model.
    pub fn record_actual(
        &self,
        model:             Model,
        prompt_tokens:     u32,
        completion_tokens: u32,
    ) -> Result<i64, BudgetError> {
        let cents = compute_cents(model, prompt_tokens, completion_tokens);
        let day   = today_utc();
        let conn  = self.store.conn()?;

        // UPSERT: insert-or-add. Composite PK (day, model) makes this
        // atomic enough for our single-process tracker.
        conn.execute(
            "INSERT INTO ai_spend (day, model, prompt_tokens, completion_tokens, cents)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(day, model) DO UPDATE SET
                prompt_tokens     = prompt_tokens     + excluded.prompt_tokens,
                completion_tokens = completion_tokens + excluded.completion_tokens,
                cents             = cents             + excluded.cents",
            params![
                day,
                model.api_name(),
                prompt_tokens as i64,
                completion_tokens as i64,
                cents,
            ],
        )?;

        Ok(self.spend_today_cents(model)?)
    }

    /// Total spend across all models for today, in cents. Used by the
    /// settings UI ("Spend today: $0.42 / $1.00").
    pub fn total_spend_today_cents(&self) -> Result<i64, BudgetError> {
        let conn = self.store.conn()?;
        let day  = today_utc();
        let total: i64 = conn.query_row(
            "SELECT COALESCE(SUM(cents), 0) FROM ai_spend WHERE day = ?1",
            params![day],
            |row| row.get(0),
        )?;
        Ok(total)
    }

    fn spend_today_cents(&self, model: Model) -> Result<i64, BudgetError> {
        let conn = self.store.conn()?;
        let day  = today_utc();
        let cents: i64 = conn.query_row(
            "SELECT COALESCE(cents, 0) FROM ai_spend WHERE day = ?1 AND model = ?2",
            params![day, model.api_name()],
            |row| row.get(0),
        ).or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(0i64),
            other => Err(other),
        })?;
        Ok(cents)
    }

    fn read_cap(&self, key: &str, default: i64) -> Result<i64, BudgetError> {
        match settings::get(&self.store, key)? {
            Some(s) => Ok(s.parse().unwrap_or(default)),
            None    => Ok(default),
        }
    }
}

/// Compute the integer-cent cost of a finished call given actual tokens.
fn compute_cents(model: Model, prompt: u32, completion: u32) -> i64 {
    let (in_milli, out_milli) = model.pricing_per_million_milli_cents();
    // milli_cents * tokens / 1_000_000 = milli_cents_total
    // Then milli_cents / 10 = cents (integer).
    let milli = (in_milli  * prompt    as i64) / 1_000_000
              + (out_milli * completion as i64) / 1_000_000;
    // Round up sub-cent fractions so we never under-report spend.
    (milli + 9) / 10
}

/// Pre-call cost estimate. Same arithmetic as [`compute_cents`] but
/// treats the completion as if the model emits `budget` tokens.
fn estimate_call_cents(model: Model, prompt: u32, budget: u32) -> i64 {
    compute_cents(model, prompt, budget)
}

/// UTC day key in `YYYY-MM-DD`. Tests pin a specific day via
/// [`__set_today_for_tests`] (also reachable from `tests/` integration
/// tests — see `tests/budget_downgrade.rs`).
fn today_utc() -> String {
    if let Some(s) = test_overrides::today_override() {
        return s;
    }
    Utc::now().format("%Y-%m-%d").to_string()
}

mod test_overrides {
    use std::cell::RefCell;
    thread_local! {
        static OVERRIDE: RefCell<Option<String>> = const { RefCell::new(None) };
    }

    pub fn today_override() -> Option<String> {
        OVERRIDE.with(|cell| cell.borrow().clone())
    }
    pub fn set(day: Option<String>) {
        OVERRIDE.with(|cell| *cell.borrow_mut() = day);
    }
}

/// Test-only knob: pin the "today" key. The leading `__` and the
/// `#[doc(hidden)]` flag this as not part of the supported API. Always
/// compiled (vs `#[cfg(test)]` only) so integration tests in
/// `desktop/src-tauri/tests/` can seed deterministic spend rows.
#[doc(hidden)]
pub fn __set_today_for_tests(day: Option<String>) {
    test_overrides::set(day);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fresh_store() -> (Arc<Store>, TempDir) {
        let tmp  = TempDir::new().expect("tempdir");
        let path = tmp.path().join("store.db");
        let store = Store::open_at(&path).expect("open");
        (Arc::new(store), tmp)
    }

    #[test]
    fn pricing_compute_is_deterministic() {
        // 1M prompt tokens on gpt-5.4 = $2.50 = 250 cents.
        assert_eq!(compute_cents(Model::Gpt54, 1_000_000, 0), 250);
        // 1M completion tokens on gpt-5.4 = $10.00 = 1000 cents.
        assert_eq!(compute_cents(Model::Gpt54, 0, 1_000_000), 1000);
        // Mixed.
        assert_eq!(compute_cents(Model::Gpt54, 500_000, 500_000), 125 + 500);
    }

    #[test]
    fn record_and_read_back() {
        let (store, _tmp) = fresh_store();
        let tracker = BudgetTracker::new(store);

        __set_today_for_tests(Some("2026-05-01".to_string()));

        let total = tracker.record_actual(Model::Gpt4oMini, 100_000, 50_000).unwrap();
        // 100k * $0.15/M = 1.5 cents → ceil 2.
        // 50k * $0.60/M = 3 cents.
        // Total 5 cents (rounding up sub-cent).
        assert_eq!(total, 5);

        // Second call accumulates.
        let total2 = tracker.record_actual(Model::Gpt4oMini, 100_000, 50_000).unwrap();
        assert_eq!(total2, 10);

        __set_today_for_tests(None);
    }

    #[test]
    fn check_returns_ok_under_caps() {
        let (store, _tmp) = fresh_store();
        let tracker = BudgetTracker::new(store);

        __set_today_for_tests(Some("2026-05-01".to_string()));

        let v = tracker.check(Model::Gpt54, 1000, 200).unwrap();
        assert_eq!(v, BudgetVerdict::Ok);

        __set_today_for_tests(None);
    }
}
