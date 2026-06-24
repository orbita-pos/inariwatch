-- VAR Q1 Foundation — session_id propagation + telemetry + What-If table.
--
-- This migration is the first step of the Verifiable Autonomous Remediation
-- (VAR) year plan. It enables three things:
--
--   1. Direct session_id (text) on alerts and substrate_recordings — comes
--      straight from the X-IW-Session-Id header. The existing alerts.replay_session_id
--      (uuid FK to replay_sessions.id, migration 0053) keeps working; this new
--      text column is the *unresolved* id the browser sent so we can correlate
--      even when replay v2 isn't active or the replay row hasn't landed yet.
--
--   2. product_metrics — append-only event log used by every new VAR feature
--      to measure adoption and progress. Helper at web/lib/telemetry/product-metrics.ts.
--
--   3. whatif_replays — caches deterministic Substrate replay results per
--      (session_id, fix_id, fix_commit_sha). What-If is idempotent: same
--      inputs = same output, so we can store forever and only invalidate on
--      a new fix commit.
--
-- All changes are additive/nullable. Backward compatible — sesiones existentes
-- siguen funcionando idéntico, solo no participan en FullTrace correlation
-- hasta que el SDK propague el header.
--
-- Reverse:
--   DROP TABLE IF EXISTS whatif_replays;
--   DROP TABLE IF EXISTS product_metrics;
--   DROP INDEX IF EXISTS substrate_recordings_session_id_idx;
--   ALTER TABLE substrate_recordings DROP COLUMN IF EXISTS session_id;
--   DROP INDEX IF EXISTS alerts_session_id_idx;
--   ALTER TABLE alerts DROP COLUMN IF EXISTS session_id;

-- ── 1. session_id text on alerts ─────────────────────────────────────────────

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS session_id text;

CREATE INDEX IF NOT EXISTS alerts_session_id_idx
  ON alerts (session_id)
  WHERE session_id IS NOT NULL;

COMMENT ON COLUMN alerts.session_id IS
  'Browser session id from X-IW-Session-Id header. Independent of replay_session_id (uuid FK) — this is the raw text the SDK sent and may not yet have a replay_sessions row.';

-- ── 2. session_id text on substrate_recordings ───────────────────────────────

ALTER TABLE substrate_recordings
  ADD COLUMN IF NOT EXISTS session_id text;

CREATE INDEX IF NOT EXISTS substrate_recordings_session_id_idx
  ON substrate_recordings (session_id)
  WHERE session_id IS NOT NULL;

COMMENT ON COLUMN substrate_recordings.session_id IS
  'Same as alerts.session_id — populated from X-IW-Session-Id header at the request boundary.';

-- ── 3. product_metrics — append-only telemetry log ───────────────────────────

CREATE TABLE IF NOT EXISTS product_metrics (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  event           text NOT NULL,
  value_numeric   double precision,
  value_text      text,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Cover query patterns: "events of type X over the last N days"
-- and "all events for org Y, sorted recent-first".
CREATE INDEX IF NOT EXISTS product_metrics_event_created_idx
  ON product_metrics (event, created_at DESC);

CREATE INDEX IF NOT EXISTS product_metrics_org_created_idx
  ON product_metrics (organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL;

COMMENT ON TABLE product_metrics IS
  'VAR telemetry — every new feature emits at least one event here. Append-only. Helper: web/lib/telemetry/product-metrics.ts. Cleanup is a future cron — keep all events for now while we tune the funnel.';

-- ── 4. whatif_replays — deterministic Substrate replay cache ────────────────

CREATE TABLE IF NOT EXISTS whatif_replays (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      text NOT NULL,
  fix_commit_sha  text NOT NULL,
  fix_id          uuid,
  -- Result schema: { events: [...], divergence_at_ms, summary, error? }
  -- Stored as jsonb so the client can render different views without
  -- requiring a schema migration each time we add a field.
  result          jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'ready',
  computed_at     timestamptz NOT NULL DEFAULT now(),
  -- Soft TTL helper — the cache itself never expires (deterministic replay)
  -- but we record last access so a future LRU sweep has data to work with.
  last_accessed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatif_replays_unique_per_fix
    UNIQUE (session_id, fix_commit_sha)
);

CREATE INDEX IF NOT EXISTS whatif_replays_session_idx
  ON whatif_replays (session_id);

CREATE INDEX IF NOT EXISTS whatif_replays_fix_idx
  ON whatif_replays (fix_id)
  WHERE fix_id IS NOT NULL;

COMMENT ON TABLE whatif_replays IS
  'Cache of Substrate What-If replays. Keyed by (session_id, fix_commit_sha) because replay is deterministic — same session + same code = same output. fix_id is denormalized (FK varies by storage layout); commit sha is the source of truth for invalidation.';
