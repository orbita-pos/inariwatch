-- InariLens — internal AI observability.
--
-- Adds prompt + response capture to ai_usage_logs so we can debug production
-- AI behavior without shipping prompts to a third party (Helicone, Langfuse).
-- Prompts and responses are PII-scrubbed in the logger before insert.
--
-- Columns:
--   request_id               uuid, one per call, indexed UNIQUE for O(1) lookup
--   prompt                   full prompt text ([SYSTEM]...\n---\n[USER]...) — nullable
--                            so existing rows stay valid and show "not captured"
--   response                 model response text — nullable (null on error)
--   cached                   true when the call was served from a cache (defaults
--                            to false for live AI calls; reserved for future
--                            redis-cache-hit logging)
--   replay_of_request_id     when a row was generated via the admin replay UI,
--                            this points back to the original call so we can
--                            show lineage in the detail view

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS prompt text,
  ADD COLUMN IF NOT EXISTS response text,
  ADD COLUMN IF NOT EXISTS cached boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS replay_of_request_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_logs_request_id
  ON ai_usage_logs(request_id);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_feature_created
  ON ai_usage_logs(feature, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_replay_of
  ON ai_usage_logs(replay_of_request_id)
  WHERE replay_of_request_id IS NOT NULL;
