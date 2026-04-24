-- Fase 6.1 — tier_router_labels
--
-- Human ground-truth for tier router accuracy. Operators label completed
-- shadow/live remediation sessions with the tier they SHOULD have taken.
-- The /admin/ai Shadow Classification widget switches from outcome-based
-- approximation ("did the session pass post-merge monitoring?") to real
-- agreement ("did the classifier pick the same tier the human picked?")
-- once this table accumulates >= 50 rows.
--
-- One label per session per labeler. A second labeler can re-label the
-- same session for inter-rater agreement; the UI shows the latest by
-- default and dedupes on (session_id, labeler_user_id).
--
-- Rollback:
--   DROP TABLE IF EXISTS tier_router_labels;

CREATE TABLE IF NOT EXISTS tier_router_labels (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid NOT NULL REFERENCES remediation_sessions(id) ON DELETE CASCADE,
  labeler_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The tier the human believes was correct given alert + diagnosis + final
  -- patch. Constrained to the four valid tiers — no 'legacy' here, that's
  -- a router state, not a human judgment.
  human_tier         text NOT NULL,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE tier_router_labels
    ADD CONSTRAINT tier_router_labels_human_tier_valid
    CHECK (human_tier IN ('0', '1', '2', '3'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One label per session per labeler. Re-labeling overwrites via UPSERT.
CREATE UNIQUE INDEX IF NOT EXISTS tier_router_labels_session_labeler_idx
  ON tier_router_labels (session_id, labeler_user_id);

-- Listing index for the admin UI: most recent first.
CREATE INDEX IF NOT EXISTS tier_router_labels_created_idx
  ON tier_router_labels (created_at DESC);

COMMENT ON TABLE tier_router_labels IS
  'Fase 6.1 — human ground-truth for tier router accuracy. The /admin/ai widget upgrades from outcome-based approximation to real agreement once this table holds >= 50 rows. Required gate before promoting TIER_ROUTER_MODE from shadow to live in production.';
