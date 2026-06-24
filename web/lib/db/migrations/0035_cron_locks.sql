-- Prevent concurrent cron invocations from processing in parallel.
-- Uses INSERT ON CONFLICT with expiry check as a lightweight advisory lock.
CREATE TABLE IF NOT EXISTS cron_locks (
  key TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '120 seconds'
);
