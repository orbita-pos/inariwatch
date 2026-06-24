-- Track why AI auto-analyze was skipped on a given alert.
-- Null = AI ran (or hasn't been attempted yet).
-- Values: 'quota' | 'platform_budget' | 'no_key'
--
-- Drives the contextual banner on the alert detail page so users don't
-- think the product is broken when free-tier AI is paused.

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS ai_skipped_reason text;
