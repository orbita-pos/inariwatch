ALTER TABLE alerts ADD COLUMN IF NOT EXISTS alert_type TEXT DEFAULT 'error' NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(alert_type);
