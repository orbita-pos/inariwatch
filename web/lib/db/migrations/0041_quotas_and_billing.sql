-- Quota tracking + Stripe billing for Free/Pro tiers
--
-- Free: 300 auto / 3 remediations / 100 chat / 10 PR predictions / 5 postmortems
-- Pro $12/mo: 3000 / 25 / 500 / 30 / 50

-- ── Stripe billing columns on users ─────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status TEXT,
  -- 'active' | 'past_due' | 'canceled' | 'incomplete' | 'trialing'
  ADD COLUMN IF NOT EXISTS subscription_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_cancel_at_period_end BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_users_stripe_sub ON users(stripe_subscription_id);

-- ── Monthly quota usage ─────────────────────────────────────────────────────
-- One row per user per month per feature. Counters increment as features are used.
-- Reset by cron on day 1 of each month (or just create new rows with new period).
CREATE TABLE IF NOT EXISTS monthly_quota_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Period start (always first day of month at 00:00 UTC)
  period_start TIMESTAMPTZ NOT NULL,

  -- Counters per feature
  auto_analyze_used INTEGER NOT NULL DEFAULT 0,
  remediation_used INTEGER NOT NULL DEFAULT 0,
  chat_used INTEGER NOT NULL DEFAULT 0,
  pr_prediction_used INTEGER NOT NULL DEFAULT 0,
  postmortem_used INTEGER NOT NULL DEFAULT 0,

  -- Last update for debugging
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One row per user per period
  UNIQUE (user_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_quota_usage_user_period
  ON monthly_quota_usage(user_id, period_start DESC);
