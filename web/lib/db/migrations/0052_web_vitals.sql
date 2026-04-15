-- Phase G — Web Vitals summary per replay session.
--
-- Stored as a single jsonb column keyed by vital name, value:
--   { LCP: { value: 2400, rating: "good" },
--     CLS: { value: 0.12, rating: "needs-improvement" },
--     INP: { value: 220, rating: "needs-improvement" },
--     FCP: { value: 1800, rating: "good" },
--     TTFB:{ value: 600,  rating: "good" } }
--
-- Always read alongside the session (player header + list badge), so jsonb
-- on the row matches the aiChapters / rageClicks pattern. Default '{}' so
-- old rows + sessions awaiting the analyzer read as "no vitals captured"
-- without null guards.

ALTER TABLE replay_sessions
  ADD COLUMN IF NOT EXISTS web_vitals jsonb NOT NULL DEFAULT '{}'::jsonb;
