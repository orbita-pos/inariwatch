-- Phase H — bidirectional link between alerts and replay sessions.
--
-- The replay_sessions side already has alertId (migration 0046). This adds
-- the inverse so given an alert we can fetch its replay context for the
-- remediation agent without scanning replay_sessions for matching FK.
--
-- ON DELETE SET NULL — deleting a replay session (retention sweep) must
-- not cascade-delete the alert it correlated with. The alert is the unit
-- of remediation history; replays are supplementary.
--
-- Partial index: only alerts that actually have a replay get indexed.
-- Most alerts won't (Vercel deploy failures, npm CVEs, etc.).

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS replay_session_id uuid REFERENCES replay_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS alerts_replay_session_idx
  ON alerts (replay_session_id)
  WHERE replay_session_id IS NOT NULL;
