-- Webhook idempotency: track processed Stripe event IDs to handle retries.
-- Stripe sends webhooks with at-least-once delivery — same event_id can arrive
-- multiple times. We must process each event_id exactly once.
CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,           -- 'stripe', 'github', etc.
  event_type TEXT NOT NULL,       -- 'checkout.session.completed', etc.
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-cleanup old events to prevent unbounded growth (90-day retention)
CREATE INDEX IF NOT EXISTS idx_processed_webhook_events_processed_at
  ON processed_webhook_events(processed_at);
