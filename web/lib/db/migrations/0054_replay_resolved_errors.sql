-- Phase I.c — Errors panel + (eventually) source-mapped stack frames.
--
-- One row per UNIQUE error fingerprint observed in the session, with the
-- full structured stack pre-parsed at analyze time (so the player doesn't
-- have to re-split raw stack strings on every render). Empty `[]` for
-- sessions that never threw.
--
-- Schema of each entry (validated by the analyzer, not the DB):
--   { fingerprint, message, count, firstTimestamp, frames: [
--       { source, line, col, fnName?, mapped?: { file, line, col } }
--     ] }
--
-- The `mapped` field is null today; a later source-map worker will fill it
-- in without any DB / UI change.

ALTER TABLE replay_sessions
  ADD COLUMN IF NOT EXISTS resolved_errors jsonb NOT NULL DEFAULT '[]'::jsonb;
