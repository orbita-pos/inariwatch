use anyhow::Result;
use chrono::{DateTime, Utc};
use dirs::data_local_dir;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Alert {
    pub id: String,
    pub project: String,
    pub severity: String,
    pub title: String,
    pub body: String,
    pub source_integrations: Vec<String>,
    pub is_read: bool,
    pub sent_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

// ── Connection ────────────────────────────────────────────────────────────────

pub fn db_path() -> PathBuf {
    data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("kairo")
        .join("kairo.db")
}

pub fn open() -> Result<Connection> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(&path)?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS events (
            id           TEXT PRIMARY KEY,
            project      TEXT NOT NULL,
            integration  TEXT NOT NULL,
            event_type   TEXT NOT NULL,
            payload      TEXT NOT NULL,
            fingerprint  TEXT UNIQUE,
            occurred_at  TEXT NOT NULL,
            processed_at TEXT,
            created_at   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS alerts (
            id                   TEXT PRIMARY KEY,
            project              TEXT NOT NULL,
            severity             TEXT NOT NULL,
            title                TEXT NOT NULL,
            body                 TEXT NOT NULL,
            source_integrations  TEXT NOT NULL,
            is_read              INTEGER NOT NULL DEFAULT 0,
            sent_at              TEXT,
            created_at           TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_alerts_project
            ON alerts(project, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_events_fingerprint
            ON events(fingerprint);
        ",
    )?;
    Ok(())
}

// ── Queries ───────────────────────────────────────────────────────────────────

pub fn fingerprint_exists(conn: &Connection, fingerprint: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM events WHERE fingerprint = ?1",
        params![fingerprint],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

pub fn insert_event(
    conn: &Connection,
    id: &str,
    project: &str,
    integration: &str,
    event_type: &str,
    payload: &str,
    fingerprint: &str,
    occurred_at: &str,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO events
             (id, project, integration, event_type, payload, fingerprint, occurred_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, project, integration, event_type, payload, fingerprint, occurred_at, now],
    )?;
    Ok(())
}

pub fn insert_alert(conn: &Connection, alert: &Alert) -> Result<()> {
    let sources = serde_json::to_string(&alert.source_integrations)?;
    let sent_at = alert.sent_at.map(|t| t.to_rfc3339());
    conn.execute(
        "INSERT INTO alerts
             (id, project, severity, title, body, source_integrations, is_read, sent_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            alert.id,
            alert.project,
            alert.severity,
            alert.title,
            alert.body,
            sources,
            alert.is_read as i64,
            sent_at,
            alert.created_at.to_rfc3339()
        ],
    )?;
    Ok(())
}

pub fn get_recent_alerts(
    conn: &Connection,
    project: Option<&str>,
    limit: usize,
) -> Result<Vec<Alert>> {
    let alerts = match project {
        Some(proj) => {
            let mut stmt = conn.prepare(
                "SELECT id, project, severity, title, body, source_integrations,
                        is_read, sent_at, created_at
                 FROM alerts
                 WHERE project = ?1
                 ORDER BY created_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(params![proj, limit as i64], row_to_alert)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT id, project, severity, title, body, source_integrations,
                        is_read, sent_at, created_at
                 FROM alerts
                 ORDER BY created_at DESC
                 LIMIT ?1",
            )?;
            let rows = stmt
                .query_map(params![limit as i64], row_to_alert)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        }
    };
    Ok(alerts)
}

fn row_to_alert(row: &rusqlite::Row) -> rusqlite::Result<Alert> {
    let sources_str: String = row.get(5)?;
    let sources: Vec<String> = serde_json::from_str(&sources_str).unwrap_or_default();

    let sent_at_str: Option<String> = row.get(7)?;
    let created_at_str: String = row.get(8)?;

    Ok(Alert {
        id: row.get(0)?,
        project: row.get(1)?,
        severity: row.get(2)?,
        title: row.get(3)?,
        body: row.get(4)?,
        source_integrations: sources,
        is_read: row.get::<_, i64>(6)? != 0,
        sent_at: sent_at_str
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
            .map(|t| t.with_timezone(&Utc)),
        created_at: DateTime::parse_from_rfc3339(&created_at_str)
            .map(|t| t.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    })
}
