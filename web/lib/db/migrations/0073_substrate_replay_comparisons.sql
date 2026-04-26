-- Sesión 18 / Track G part 5 — Substrate v2 in-loop gate canary
--
-- Side-by-side comparison log between the legacy v1 (AI-analysis) replay gate
-- and the new v2 (deterministic, RaaS) replay gate. Populated only when the
-- canary fires — i.e. SUBSTRATE_V2_GATE=true AND the alert hashes into the 5%
-- canary bucket. With the flag off this table stays empty and the in-loop
-- gate is byte-identical to project_var_in_loop_replay.md.
--
-- One row per agentic-loop turn that ran the gate. Stores both verdicts (v1
-- shadow + v2 primary) plus a derived `agreed` column the dashboard widget
-- reads to compute success rates and disagreement counts.
--
-- Promotion gate: aim is 1 week of canary with no regression vs v1 — defined
-- as agreement >= 90% on the rows where both verdicts are non-null.
--
-- Rollback:
--   DROP TABLE IF EXISTS substrate_replay_comparisons;

CREATE TABLE IF NOT EXISTS substrate_replay_comparisons (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  alert_id                 uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  remediation_session_id   uuid REFERENCES remediation_sessions(id) ON DELETE SET NULL,
  -- Free-form recording id (the substrate_recordings.recording_id text col).
  recording_id             text,

  -- v1 (AI-analysis) verdict. NULL when v1 wasn't run (e.g. canary picked
  -- v2-only) or when v1 returned null (no recording).
  v1_passed                boolean,
  v1_risk_score            integer,
  v1_confidence            integer,
  v1_reason                text,
  v1_duration_ms           integer,

  -- v2 (RaaS / deterministic) verdict. NULL when /v2/replay was unreachable,
  -- the binary returned 503 (not deployed), or no v2 recording was available.
  v2_passed                boolean,
  v2_risk_score            integer,
  v2_confidence            integer,
  v2_reason                text,
  v2_duration_ms           integer,
  -- One of: 'drain' | 'live' | 'diff' | 'no_recording' | 'error' | 'unconfigured'.
  v2_runner_mode           text,

  -- Which verdict the loop actually used. 'v2' = v2 was primary; 'v1' = the
  -- canary fired but v2 was unusable so we fell back; 'v1_only' = no canary,
  -- standard path (rarely persisted — only when shadow mode forces a log).
  chosen                   text NOT NULL,

  -- Convenience: TRUE iff both v1_passed and v2_passed are non-null and
  -- equal. NULL when one verdict is missing. Lets the widget aggregate
  -- without re-walking the booleans.
  agreed                   boolean,

  created_at               timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE substrate_replay_comparisons
    ADD CONSTRAINT substrate_replay_comparisons_chosen_valid
    CHECK (chosen IN ('v2', 'v1', 'v1_only'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS substrate_replay_comparisons_created_idx
  ON substrate_replay_comparisons (created_at DESC);

CREATE INDEX IF NOT EXISTS substrate_replay_comparisons_alert_idx
  ON substrate_replay_comparisons (alert_id);

CREATE INDEX IF NOT EXISTS substrate_replay_comparisons_session_idx
  ON substrate_replay_comparisons (remediation_session_id)
  WHERE remediation_session_id IS NOT NULL;

COMMENT ON TABLE substrate_replay_comparisons IS
  'Sesión 18 — side-by-side log of v1 (AI-analysis) vs v2 (RaaS) substrate replay verdicts during the SUBSTRATE_V2_GATE canary. Drives the /admin/ops widget that tracks v1 vs v2 success rates + disagreement count. Empty when SUBSTRATE_V2_GATE is off.';

COMMENT ON COLUMN substrate_replay_comparisons.chosen IS
  'Which gate verdict the agentic loop actually applied. v2 = canary fired and v2 returned a verdict; v1 = canary fired but v2 was unusable (no recording / 503 / network) and we fell back; v1_only = standard non-canary path (only persisted in special shadow modes).';
