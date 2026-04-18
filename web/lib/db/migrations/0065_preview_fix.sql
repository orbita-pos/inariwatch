-- Preview Fix — two-tier visual preview of autonomous remediations.
--
-- When a remediation completes + `merged_commit_sha` is populated, the alert
-- detail page unlocks a new "Preview fix" panel that renders two views side-
-- by-side:
--
--   Tier 3 · AI-predicted HTML (2-3s)
--     Claude Sonnet takes the last rrweb FullSnapshot from the alert's
--     Substrate recording + the commit diff, returns predicted HTML. Rendered
--     in a sandboxed iframe with a "may differ from live" watermark. Cached
--     per (alert_id, merged_commit_sha) in `preview_predictions`.
--
--   Tier 1 · Live ephemeral deploy (30-60s)
--     Go staging server clones the fix branch into a fresh Docker container,
--     Caddy dynamic route maps `<uuid>.staging.inariwatch.com` → the port
--     the container exposed. 24h TTL (vs 5min for Gate 14 staging). Persisted
--     columns prefixed with `live_*` on `preview_sessions`.
--
-- Shareability:
--   Each session gets a 12-char base32 `public_slug` — unguessable, capability-
--   URL style (same model as /attestation/<id>). Served from
--   /preview/<slug> with no auth. `public_slug` is deliberately decoupled from
--   `id` so we can rotate it (revoke) without breaking internal references.
--
-- Idempotency:
--   UNIQUE (alert_id, remediation_session_id) — re-hitting POST on an already-
--   previewed remediation returns the existing row rather than creating a new
--   container. Prevents accidental duplicate spins.
--
-- Reverse:
--   DROP INDEX IF EXISTS remediation_sessions_preview_idx;
--   ALTER TABLE remediation_sessions
--     DROP COLUMN IF EXISTS preview_session_id,
--     DROP COLUMN IF EXISTS preview_enabled_at;
--   DROP TABLE IF EXISTS preview_predictions;
--   DROP TABLE IF EXISTS preview_sessions;


-- ── preview_predictions (AI render cache) ────────────────────────────────────
--
-- Keyed by (alert_id, merged_commit_sha) so re-requesting the same alert+fix
-- always reuses the same render. The AI call costs ~6¢ per miss — caching is
-- the difference between "one-off POC" and "production-affordable."

CREATE TABLE IF NOT EXISTS preview_predictions (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id          uuid          NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  merged_commit_sha text          NOT NULL,

  -- The rendered HTML the iframe's srcDoc will receive. Already sanitized
  -- (DOMPurify strict config) at write time. Stored as-is, served as-is.
  predicted_html    text          NOT NULL,
  original_html     text          NOT NULL,
  diff_summary      text          NOT NULL DEFAULT '',
  target_selectors  jsonb         NOT NULL DEFAULT '[]'::jsonb,
  confidence        integer       NOT NULL DEFAULT 0,

  -- Cost accounting — same pattern as ai_usage_logs would track per call.
  -- Kept inline here so the admin "previews" dashboard can read everything
  -- from one row without joining.
  tokens_in         integer       NOT NULL DEFAULT 0,
  tokens_out        integer       NOT NULL DEFAULT 0,
  cost_cents        integer       NOT NULL DEFAULT 0,

  created_at        timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT preview_predictions_unique_per_commit
    UNIQUE (alert_id, merged_commit_sha)
);

CREATE INDEX IF NOT EXISTS preview_predictions_alert_idx
  ON preview_predictions (alert_id, created_at DESC);

COMMENT ON TABLE preview_predictions IS
  'AI-predicted HTML cache for the Preview Fix feature. One row per (alert_id, merged_commit_sha). Written by tier3-predict.service after a successful Claude call; read whenever a preview_sessions row hydrates. Cache is never evicted — new commits get new rows.';


-- ── preview_sessions (one per alert + remediation) ───────────────────────────
--
-- Orchestrates the two tiers. Rows are created on POST /api/alerts/:id/preview,
-- mutated by tier1-live.service (live_*) and tier3-predict.service
-- (prediction_*) as each tier makes progress, and read by the public page via
-- `public_slug`.

CREATE TABLE IF NOT EXISTS preview_sessions (
  id                     uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 12 chars of base32 (≈60 bits of entropy). Populated by service (not a DB
  -- default) so we can retry on UNIQUE collision without losing the row.
  public_slug            text         NOT NULL UNIQUE,

  alert_id               uuid         NOT NULL REFERENCES alerts(id)               ON DELETE CASCADE,
  project_id             uuid         NOT NULL REFERENCES projects(id)             ON DELETE CASCADE,
  organization_id        uuid                  REFERENCES organizations(id)        ON DELETE SET NULL,
  remediation_session_id uuid         NOT NULL REFERENCES remediation_sessions(id) ON DELETE CASCADE,

  -- Denormalized at insert so the public page never joins remediation_sessions.
  eap_receipt_id         text,

  -- ── Tier 1 (live deploy) ───────────────────────────────────────────────────
  live_status            text         NOT NULL DEFAULT 'pending',
  -- pending | provisioning | building | running | failed | expired
  live_deploy_id         text,
  live_url               text,
  live_hostname          text,
  live_port              integer,
  live_build_logs        text,        -- last ~32KB, rolled
  live_error             text,
  live_started_at        timestamptz,
  live_ready_at          timestamptz,
  live_expires_at        timestamptz,

  -- ── Tier 3 (AI prediction) ─────────────────────────────────────────────────
  prediction_status      text         NOT NULL DEFAULT 'pending',
  -- pending | rendering | ready | failed | skipped
  prediction_id          uuid                  REFERENCES preview_predictions(id)  ON DELETE SET NULL,
  prediction_error       text,

  -- ── Observability / engagement ────────────────────────────────────────────
  build_duration_ms      integer,
  prediction_duration_ms integer,
  prediction_tokens_in   integer,
  prediction_tokens_out  integer,
  prediction_cents       integer,
  view_count             integer      NOT NULL DEFAULT 0,
  tier1_click_count      integer      NOT NULL DEFAULT 0,
  tier3_click_count      integer      NOT NULL DEFAULT 0,

  -- ── Lifecycle ──────────────────────────────────────────────────────────────
  -- Populated by the org owner's "revoke share" action. When set, the public
  -- slug endpoint returns 410 Gone and the embedded panel hides the share
  -- affordance. We don't delete the row so internal references stay valid.
  revoked_at             timestamptz,

  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now(),

  -- One preview per (alert, remediation). Re-hit returns existing row.
  CONSTRAINT preview_sessions_unique_per_remediation
    UNIQUE (alert_id, remediation_session_id)
);

-- Hot path: public page resolves by slug.
CREATE INDEX IF NOT EXISTS preview_sessions_slug_idx
  ON preview_sessions (public_slug);

-- Admin dashboard + org-level listings.
CREATE INDEX IF NOT EXISTS preview_sessions_org_idx
  ON preview_sessions (organization_id, created_at DESC);

-- Cron sweep (Session 2): "running/building previews whose TTL has expired".
CREATE INDEX IF NOT EXISTS preview_sessions_expiry_idx
  ON preview_sessions (live_expires_at)
  WHERE live_status IN ('running', 'building');

COMMENT ON TABLE preview_sessions IS
  'Preview Fix feature orchestration row. One per (alert_id, remediation_session_id). Tier 1 columns (live_*) track the ephemeral Docker container deployment; Tier 3 columns (prediction_*) track the AI-predicted HTML render. Shareable via public_slug at /preview/<slug>.';

COMMENT ON COLUMN preview_sessions.public_slug IS
  '12-char base32 unguessable slug. The URL /preview/<slug> is the capability. Slug can be rotated by clearing and regenerating on revoke; revoked_at hides it from the public endpoint.';

COMMENT ON COLUMN preview_sessions.live_status IS
  'pending, provisioning, building, running, failed, or expired. Mutated by tier1-live.service as the Go staging server reports progress.';

COMMENT ON COLUMN preview_sessions.prediction_status IS
  'pending, rendering, ready, failed, or skipped. "skipped" when no rrweb FullSnapshot available for the alert (background-job or server-only errors).';


-- ── remediation_sessions backpointer ────────────────────────────────────────
--
-- Forward lookup (alert → preview) is covered by the FK in preview_sessions,
-- but the alert detail page loads `latestRemediation` first and needs to know
-- whether a preview exists without a second query. Two nullable columns:

ALTER TABLE remediation_sessions
  ADD COLUMN IF NOT EXISTS preview_session_id  uuid REFERENCES preview_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS preview_enabled_at  timestamptz;

-- Skinny partial index — the vast majority of rows will have NULL for a long
-- time.
CREATE INDEX IF NOT EXISTS remediation_sessions_preview_idx
  ON remediation_sessions (preview_session_id)
  WHERE preview_session_id IS NOT NULL;

COMMENT ON COLUMN remediation_sessions.preview_session_id IS
  'FK to preview_sessions — populated by session.service.ts::getOrCreatePreviewSession on first preview request. Decoupled from the preview row itself so we can keep remediation history even if a preview is later deleted.';

COMMENT ON COLUMN remediation_sessions.preview_enabled_at IS
  'Timestamp of first preview creation. Drives the "X days since last preview" UI and dashboard analytics.';
