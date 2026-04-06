-- Prevent dedup race conditions: atomic INSERT ON CONFLICT needs a unique index.
-- Only enforces uniqueness for unresolved alerts with a fingerprint (partial index).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  idx_alerts_dedup ON alerts (project_id, fingerprint)
  WHERE is_resolved = false AND fingerprint IS NOT NULL;
