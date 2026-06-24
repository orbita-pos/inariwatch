-- Add UI session events column for rrweb-based browser session replay
ALTER TABLE "substrate_recordings" ADD COLUMN "ui_events" jsonb;
