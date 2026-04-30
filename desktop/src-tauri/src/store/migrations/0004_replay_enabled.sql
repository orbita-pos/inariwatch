-- 0004_replay_enabled: opt-in flag for the substrate replay sensor.
--
-- Sensor 6 (Sesión 10) only correlates `FsChange::Modified` against the
-- latest `.inari/recordings/<id>/` directory when this flag is set on
-- the repo. Default `FALSE` keeps the new sensor inert for every repo
-- already in the user's store on upgrade — Replay-as-you-code is opt-in
-- per the dock spec § Sensors.

ALTER TABLE repos ADD COLUMN replay_enabled INTEGER NOT NULL DEFAULT 0;
