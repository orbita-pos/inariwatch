-- Preview Fix — visual capture for share URLs + panel card.
--
-- Adds screenshot metadata on preview_sessions. The PNG itself lives on
-- Vercel Blob (permanent CDN-served storage, survives past the 24h preview
-- container TTL). We only persist the public URL + dimensions + timestamp
-- here — the Blob is the single source of truth for the bytes.
--
-- Why not bytea: storing 500KB+ PNGs per row bloats Neon and kills query
-- latency once row count grows, and every view of the public /preview/<slug>
-- page would re-read the full column. With a Blob URL the image is served
-- from edge CDN, cached forever, and the preview_sessions row stays small.

ALTER TABLE preview_sessions
  ADD COLUMN IF NOT EXISTS screenshot_url        text,
  ADD COLUMN IF NOT EXISTS screenshot_taken_at   timestamp,
  ADD COLUMN IF NOT EXISTS screenshot_width      integer,
  ADD COLUMN IF NOT EXISTS screenshot_height     integer,
  ADD COLUMN IF NOT EXISTS screenshot_error      text;
