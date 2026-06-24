-- Integration health tracking — passive 401 detection.
--
-- When a GitHub (or other service) call returns 401, we flip is_active = false
-- and stamp last_error_at + last_error_message so the /integrations UI can
-- show a red "token expired" banner with a one-click Reconnect CTA. Zero cron,
-- zero extra API quota — the next real use of the token IS the probe.
--
-- Both columns nullable and additive: existing rows keep working unchanged.

ALTER TABLE project_integrations
  ADD COLUMN IF NOT EXISTS last_error_at       timestamp,
  ADD COLUMN IF NOT EXISTS last_error_message  text;
