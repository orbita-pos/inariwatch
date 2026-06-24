-- 0005_ai_spend: per-day AI spend tracker.
--
-- Session 18. Powers BudgetTracker: each (day, model) row accumulates
-- the prompt + completion token counts and the integer cents spent
-- since UTC midnight. Caps live in settings (well-known keys
-- `ai_global_cap_cents` / `ai_per_user_cap_cents`); the table is just
-- the running counter the tracker reads + upserts on each call.
--
-- `day` is the UTC YYYY-MM-DD bucket so we don't have to reason about
-- local-time daylight savings. The composite PK keeps one row per
-- (day, model) pair so we can attribute spend cleanly between mini
-- and full models.

CREATE TABLE IF NOT EXISTS ai_spend (
    day               TEXT    NOT NULL,
    model             TEXT    NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cents             INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, model)
);

CREATE INDEX IF NOT EXISTS ai_spend_day_idx ON ai_spend(day);
