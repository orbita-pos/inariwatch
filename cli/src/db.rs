use anyhow::Result;
use chrono::{DateTime, Utc};
use dirs::data_local_dir;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncidentMemory {
    pub id: String,
    pub project: String,
    /// Original alert title — used for similarity search
    pub alert_title: String,
    /// What the AI diagnosed as root cause
    pub root_cause: String,
    /// Short explanation of the fix (from generate_fix)
    pub fix_summary: String,
    /// JSON array of file paths that were changed
    pub files_fixed: Vec<String>,
    /// true = CI passed and no post-merge regression
    pub fix_worked: bool,
    pub confidence: i64,
    pub pr_url: Option<String>,
    pub created_at: DateTime<Utc>,
}

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
        .join("inariwatch")
        .join("inariwatch.db")
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

        CREATE TABLE IF NOT EXISTS incident_memory (
            id          TEXT PRIMARY KEY,
            project     TEXT NOT NULL,
            alert_title TEXT NOT NULL,
            root_cause  TEXT NOT NULL,
            fix_summary TEXT NOT NULL,
            files_fixed TEXT NOT NULL,
            fix_worked  INTEGER NOT NULL DEFAULT 1,
            confidence  INTEGER NOT NULL DEFAULT 0,
            pr_url      TEXT,
            created_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_memory_project
            ON incident_memory(project, fix_worked, created_at DESC);
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

pub fn get_alert_by_id(conn: &Connection, id: &str) -> Result<Option<Alert>> {
    let mut stmt = conn.prepare(
        "SELECT id, project, severity, title, body, source_integrations,
                is_read, sent_at, created_at
         FROM alerts
         WHERE id = ?1",
    )?;
    let mut rows = stmt
        .query_map(params![id], row_to_alert)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.pop())
}

/// Mark an alert as read. Returns true if the alert existed and was updated.
pub fn mark_alert_read(conn: &Connection, id: &str) -> Result<bool> {
    let affected = conn.execute(
        "UPDATE alerts SET is_read = 1 WHERE id = ?1",
        params![id],
    )?;
    Ok(affected > 0)
}

// ── Incident memory ───────────────────────────────────────────────────────────

pub fn save_incident_memory(conn: &Connection, mem: &IncidentMemory) -> Result<()> {
    let files = serde_json::to_string(&mem.files_fixed)?;
    conn.execute(
        "INSERT OR REPLACE INTO incident_memory
             (id, project, alert_title, root_cause, fix_summary, files_fixed,
              fix_worked, confidence, pr_url, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            mem.id,
            mem.project,
            mem.alert_title,
            mem.root_cause,
            mem.fix_summary,
            files,
            mem.fix_worked as i64,
            mem.confidence,
            mem.pr_url,
            mem.created_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

/// Update a memory record to mark that the fix did NOT work (regression detected).
pub fn mark_memory_failed(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE incident_memory SET fix_worked = 0 WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// Find past successful fixes similar to the given alert title.
/// Uses simple keyword matching — good enough for local SQLite.
pub fn get_relevant_memories(
    conn: &Connection,
    project: &str,
    alert_title: &str,
    limit: usize,
) -> Result<Vec<IncidentMemory>> {
    // Extract words > 3 chars as search terms
    let keywords: Vec<String> = alert_title
        .split_whitespace()
        .filter(|w| w.len() > 3)
        .map(|w| format!("%{}%", w.to_lowercase()))
        .collect();

    if keywords.is_empty() {
        return Ok(vec![]);
    }

    // Build: WHERE project=? AND fix_worked=1 AND (title LIKE ? OR title LIKE ? ...)
    let like_clauses: String = keywords
        .iter()
        .enumerate()
        .map(|(i, _)| format!("LOWER(alert_title) LIKE ?{}", i + 2))
        .collect::<Vec<_>>()
        .join(" OR ");

    let sql = format!(
        "SELECT id, project, alert_title, root_cause, fix_summary, files_fixed,
                fix_worked, confidence, pr_url, created_at
         FROM incident_memory
         WHERE project = ?1 AND fix_worked = 1 AND ({})
         ORDER BY confidence DESC, created_at DESC
         LIMIT {}",
        like_clauses, limit
    );

    let mut stmt = conn.prepare(&sql)?;

    // Build param list: project + one keyword per slot
    let mut rows_result: Vec<IncidentMemory> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    param_values.push(Box::new(project.to_string()));
    for kw in &keywords {
        param_values.push(Box::new(kw.clone()));
    }

    let param_refs: Vec<&dyn rusqlite::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();

    let rows = stmt
        .query_map(param_refs.as_slice(), row_to_memory)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    rows_result.extend(rows);
    Ok(rows_result)
}

fn row_to_memory(row: &rusqlite::Row) -> rusqlite::Result<IncidentMemory> {
    let files_str: String = row.get(5)?;
    let files: Vec<String> = serde_json::from_str(&files_str).unwrap_or_default();
    let created_at_str: String = row.get(9)?;
    Ok(IncidentMemory {
        id: row.get(0)?,
        project: row.get(1)?,
        alert_title: row.get(2)?,
        root_cause: row.get(3)?,
        fix_summary: row.get(4)?,
        files_fixed: files,
        fix_worked: row.get::<_, i64>(6)? != 0,
        confidence: row.get(7)?,
        pr_url: row.get(8)?,
        created_at: DateTime::parse_from_rfc3339(&created_at_str)
            .map(|t| t.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    })
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
