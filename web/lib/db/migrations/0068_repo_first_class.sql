-- Migration 0068 — first-class repo column on alerts + per-project default.
--
-- Before this migration, remediate.ts tried to guess the repo at run time
-- using `extractRepo(title)` + `listOwnerRepos` + body-search fallbacks.
-- Diagnostic on 2026-04-20 showed this failed for 31/54 (57%) of recent
-- critical non-agent alerts — capture/sentry/datadog titles don't contain
-- `owner/repo`, and when the GitHub owner has >1 repo, there's no way to
-- tell which repo the alert came from.
--
-- The fix: resolve the repo canonically at ingest (every webhook handler
-- writes it) and store it on the row. A nullable per-project default
-- covers edge cases where the source cannot be inferred.
--
-- Backfill of historical alerts happens via
-- `web/scripts/backfill-alert-repo.ts`.

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS repo TEXT;
CREATE INDEX IF NOT EXISTS idx_alerts_repo ON alerts(repo) WHERE repo IS NOT NULL;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_repo TEXT;
