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
    /// Error fingerprint for fix replay matching (None for legacy rows)
    pub fingerprint: Option<String>,
    /// Auto-generated post-mortem text (None if not yet generated)
    pub postmortem_text: Option<String>,
    /// Community fix ID returned from /api/patterns/contribute (for outcome reporting)
    pub community_fix_id: Option<String>,
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
    /// Error fingerprint for outcome tracking (None for legacy alerts)
    pub fingerprint: Option<String>,
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

    // v2 migration: add fingerprint column if missing
    let has_fp: bool = conn
        .prepare("PRAGMA table_info(incident_memory)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .any(|col| col.as_deref() == Ok("fingerprint"));

    if !has_fp {
        conn.execute_batch(
            "ALTER TABLE incident_memory ADD COLUMN fingerprint TEXT;
             CREATE INDEX IF NOT EXISTS idx_memory_fingerprint
                 ON incident_memory(project, fingerprint);",
        )?;
    }

    // v2 migration: add postmortem_text column if missing
    let has_pm: bool = conn
        .prepare("PRAGMA table_info(incident_memory)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .any(|col| col.as_deref() == Ok("postmortem_text"));

    if !has_pm {
        conn.execute_batch(
            "ALTER TABLE incident_memory ADD COLUMN postmortem_text TEXT;",
        )?;
    }

    // v3 migration: add fingerprint column to alerts for outcome tracking
    let has_alert_fp: bool = conn
        .prepare("PRAGMA table_info(alerts)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .any(|col| col.as_deref() == Ok("fingerprint"));

    if !has_alert_fp {
        conn.execute_batch(
            "ALTER TABLE alerts ADD COLUMN fingerprint TEXT;",
        )?;
    }

    // v3 migration: add community_fix_id to incident_memory for outcome reporting
    let has_cfi: bool = conn
        .prepare("PRAGMA table_info(incident_memory)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .any(|col| col.as_deref() == Ok("community_fix_id"));

    if !has_cfi {
        conn.execute_batch(
            "ALTER TABLE incident_memory ADD COLUMN community_fix_id TEXT;",
        )?;
    }

    // v3 migration: shadow_predictions table
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS shadow_predictions (
            id                      TEXT PRIMARY KEY,
            project                 TEXT NOT NULL,
            alert_id                TEXT NOT NULL,
            alert_fingerprint       TEXT,
            alert_title             TEXT NOT NULL,
            predicted_diagnosis     TEXT NOT NULL,
            predicted_files         TEXT NOT NULL,
            predicted_fix_approach  TEXT NOT NULL,
            confidence              INTEGER NOT NULL DEFAULT 0,
            created_at              TEXT NOT NULL,
            human_fix_detected      INTEGER NOT NULL DEFAULT 0,
            human_fix_matched       INTEGER NOT NULL DEFAULT 0,
            human_fix_files         TEXT,
            resolved_at             TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_shadow_project
            ON shadow_predictions(project, alert_fingerprint, created_at DESC);",
    )?;

    // v2 migration: pattern_cache for Fix Replay
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS pattern_cache (
            fingerprint  TEXT PRIMARY KEY,
            pattern_data TEXT NOT NULL,
            fetched_at   TEXT NOT NULL
        );",
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
             (id, project, severity, title, body, source_integrations, is_read, sent_at, created_at, fingerprint)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            alert.id,
            alert.project,
            alert.severity,
            alert.title,
            alert.body,
            sources,
            alert.is_read as i64,
            sent_at,
            alert.created_at.to_rfc3339(),
            alert.fingerprint,
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
                        is_read, sent_at, created_at, fingerprint
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
                        is_read, sent_at, created_at, fingerprint
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
              fix_worked, confidence, pr_url, created_at, fingerprint, postmortem_text, community_fix_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
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
            mem.fingerprint,
            mem.postmortem_text,
            mem.community_fix_id,
        ],
    )?;
    Ok(())
}

/// Update the postmortem text on an existing memory record.
pub fn update_memory_postmortem(conn: &Connection, id: &str, postmortem: &str) -> Result<()> {
    conn.execute(
        "UPDATE incident_memory SET postmortem_text = ?1 WHERE id = ?2",
        params![postmortem, id],
    )?;
    Ok(())
}

// ── Trust level + track record ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum TrustLevel {
    Rookie,     // < 3 fixes — only draft PRs, no auto-merge
    Apprentice, // >= 3 fixes, >= 50% success — auto-merge with strict gates
    Trusted,    // >= 5 fixes, >= 70% success — standard gates
    Expert,     // >= 10 fixes, >= 85% success — relaxed gates
}

impl TrustLevel {
    pub fn name(&self) -> &'static str {
        match self {
            TrustLevel::Rookie => "Rookie",
            TrustLevel::Apprentice => "Apprentice",
            TrustLevel::Trusted => "Trusted",
            TrustLevel::Expert => "Expert",
        }
    }

    pub fn level(&self) -> u8 {
        match self {
            TrustLevel::Rookie => 0,
            TrustLevel::Apprentice => 1,
            TrustLevel::Trusted => 2,
            TrustLevel::Expert => 3,
        }
    }

    /// Minimum confidence required for auto-merge at this trust level.
    /// Starts at 90 (= web DEFAULT_AUTO_MERGE_CONFIG.minConfidence),
    /// relaxes as the agent earns trust through successful fixes.
    pub fn min_confidence(&self) -> u32 {
        match self {
            TrustLevel::Rookie     => 101, // impossible — never auto-merge
            TrustLevel::Apprentice => 90,  // web default
            TrustLevel::Trusted    => 80,
            TrustLevel::Expert     => 70,
        }
    }

    /// Minimum self-review score for auto-merge at this trust level.
    /// Aligned with web auto-merge-gates.ts: score >= 70.
    pub fn min_review_score(&self) -> u32 {
        match self {
            TrustLevel::Rookie     => 101,
            TrustLevel::Apprentice => 70,
            TrustLevel::Trusted    => 70,
            TrustLevel::Expert     => 70,
        }
    }

    /// Max changed lines allowed for auto-merge at this trust level.
    /// Starts at 50 (= web DEFAULT_AUTO_MERGE_CONFIG.maxLinesChanged),
    /// relaxes as the agent earns trust.
    pub fn max_changed_lines(&self) -> usize {
        match self {
            TrustLevel::Rookie     => 0,
            TrustLevel::Apprentice => 50,  // web default
            TrustLevel::Trusted    => 100,
            TrustLevel::Expert     => 200,
        }
    }
}

#[derive(Debug)]
pub struct TrackRecord {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub success_rate: f64,
    pub avg_confidence: f64,
    pub auto_merged: usize,
    pub trust_level: TrustLevel,
    pub recent: Vec<IncidentMemory>,
}

impl TrackRecord {
    /// How many more successful fixes needed to reach the next trust level.
    pub fn fixes_to_next_level(&self) -> Option<String> {
        match self.trust_level {
            TrustLevel::Rookie => {
                let need = 3usize.saturating_sub(self.total);
                Some(format!("Apprentice — {} more fix(es) needed", need))
            }
            TrustLevel::Apprentice => {
                let need_fixes = 5usize.saturating_sub(self.total);
                let need_rate = if self.success_rate < 0.70 {
                    format!(", ≥70% success rate (currently {:.0}%)", self.success_rate * 100.0)
                } else {
                    String::new()
                };
                Some(format!("Trusted — {} more fix(es){}", need_fixes, need_rate))
            }
            TrustLevel::Trusted => {
                let need_fixes = 10usize.saturating_sub(self.total);
                let need_rate = if self.success_rate < 0.85 {
                    format!(", ≥85% success rate (currently {:.0}%)", self.success_rate * 100.0)
                } else {
                    String::new()
                };
                Some(format!("Expert — {} more fix(es){}", need_fixes, need_rate))
            }
            TrustLevel::Expert => None,
        }
    }
}

fn compute_trust_level(total: usize, success_rate: f64) -> TrustLevel {
    if total >= 10 && success_rate >= 0.85 {
        TrustLevel::Expert
    } else if total >= 5 && success_rate >= 0.70 {
        TrustLevel::Trusted
    } else if total >= 3 && success_rate >= 0.50 {
        TrustLevel::Apprentice
    } else {
        TrustLevel::Rookie
    }
}

pub fn get_track_record(conn: &Connection, project: &str) -> Result<TrackRecord> {
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM incident_memory WHERE project = ?1",
        params![project],
        |r| r.get(0),
    ).unwrap_or(0);

    let succeeded: i64 = conn.query_row(
        "SELECT COUNT(*) FROM incident_memory WHERE project = ?1 AND fix_worked = 1",
        params![project],
        |r| r.get(0),
    ).unwrap_or(0);

    let avg_confidence: f64 = conn.query_row(
        "SELECT COALESCE(AVG(CAST(confidence AS REAL)), 0) FROM incident_memory WHERE project = ?1",
        params![project],
        |r| r.get(0),
    ).unwrap_or(0.0);

    let auto_merged: i64 = conn.query_row(
        "SELECT COUNT(*) FROM incident_memory WHERE project = ?1 AND fix_worked = 1 AND pr_url IS NOT NULL",
        params![project],
        |r| r.get(0),
    ).unwrap_or(0);

    let total = total as usize;
    let succeeded = succeeded as usize;
    let failed = total.saturating_sub(succeeded);
    let success_rate = if total > 0 { succeeded as f64 / total as f64 } else { 0.0 };
    let trust_level = compute_trust_level(total, success_rate);

    // Recent 5 fixes
    let mut stmt = conn.prepare(
        "SELECT id, project, alert_title, root_cause, fix_summary, files_fixed,
                fix_worked, confidence, pr_url, created_at, fingerprint, postmortem_text, community_fix_id
         FROM incident_memory
         WHERE project = ?1
         ORDER BY created_at DESC
         LIMIT 5",
    )?;
    let recent = stmt
        .query_map(params![project], row_to_memory)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap_or_default();

    Ok(TrackRecord {
        total,
        succeeded,
        failed,
        success_rate,
        avg_confidence,
        auto_merged: auto_merged as usize,
        trust_level,
        recent,
    })
}

/// Update a memory record to mark that the fix did NOT work (regression detected).
pub fn mark_memory_failed(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE incident_memory SET fix_worked = 0 WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// Find past successful fixes similar to the given alert.
/// Tries fingerprint exact match first, then falls back to keyword LIKE search.
pub fn get_relevant_memories(
    conn: &Connection,
    project: &str,
    alert_title: &str,
    fingerprint: Option<&str>,
    limit: usize,
) -> Result<Vec<IncidentMemory>> {
    // Try fingerprint match first — instant, exact
    if let Some(fp) = fingerprint {
        let fp_results = get_memories_by_fingerprint(conn, project, fp, limit)?;
        if !fp_results.is_empty() {
            return Ok(fp_results);
        }
    }

    // Fall back to keyword matching
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
                fix_worked, confidence, pr_url, created_at, fingerprint, postmortem_text, community_fix_id
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

/// Find past successful fixes by exact fingerprint match.
pub fn get_memories_by_fingerprint(
    conn: &Connection,
    project: &str,
    fingerprint: &str,
    limit: usize,
) -> Result<Vec<IncidentMemory>> {
    let mut stmt = conn.prepare(
        "SELECT id, project, alert_title, root_cause, fix_summary, files_fixed,
                fix_worked, confidence, pr_url, created_at, fingerprint, postmortem_text, community_fix_id
         FROM incident_memory
         WHERE project = ?1 AND fingerprint = ?2 AND fix_worked = 1
         ORDER BY confidence DESC, created_at DESC
         LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![project, fingerprint, limit as i64], row_to_memory)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// ── Shadow predictions ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShadowPrediction {
    pub id: String,
    pub project: String,
    pub alert_id: String,
    pub alert_fingerprint: Option<String>,
    pub alert_title: String,
    pub predicted_diagnosis: String,
    pub predicted_files: Vec<String>,
    pub predicted_fix_approach: String,
    pub confidence: i32,
    pub created_at: DateTime<Utc>,
    pub human_fix_detected: bool,
    pub human_fix_matched: bool,
    pub human_fix_files: Option<Vec<String>>,
    pub resolved_at: Option<DateTime<Utc>>,
}

pub fn save_shadow_prediction(conn: &Connection, p: &ShadowPrediction) -> Result<()> {
    let files = serde_json::to_string(&p.predicted_files)?;
    let human_files = p.human_fix_files.as_ref().map(|f| serde_json::to_string(f).unwrap_or_default());
    let resolved = p.resolved_at.map(|t| t.to_rfc3339());
    conn.execute(
        "INSERT OR REPLACE INTO shadow_predictions
             (id, project, alert_id, alert_fingerprint, alert_title,
              predicted_diagnosis, predicted_files, predicted_fix_approach,
              confidence, created_at, human_fix_detected, human_fix_matched,
              human_fix_files, resolved_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            p.id, p.project, p.alert_id, p.alert_fingerprint, p.alert_title,
            p.predicted_diagnosis, files, p.predicted_fix_approach,
            p.confidence, p.created_at.to_rfc3339(),
            p.human_fix_detected as i64, p.human_fix_matched as i64,
            human_files, resolved,
        ],
    )?;
    Ok(())
}

pub fn get_unresolved_shadows(conn: &Connection, project: &str, limit: usize) -> Result<Vec<ShadowPrediction>> {
    let mut stmt = conn.prepare(
        "SELECT id, project, alert_id, alert_fingerprint, alert_title,
                predicted_diagnosis, predicted_files, predicted_fix_approach,
                confidence, created_at, human_fix_detected, human_fix_matched,
                human_fix_files, resolved_at
         FROM shadow_predictions
         WHERE project = ?1 AND resolved_at IS NULL
         ORDER BY created_at DESC
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![project, limit as i64], |row| {
            let files_str: String = row.get(6)?;
            let files: Vec<String> = serde_json::from_str(&files_str).unwrap_or_default();
            let human_files_str: Option<String> = row.get(12)?;
            let human_files: Option<Vec<String>> = human_files_str
                .and_then(|s| serde_json::from_str(&s).ok());
            let created_str: String = row.get(9)?;
            let resolved_str: Option<String> = row.get(13)?;
            Ok(ShadowPrediction {
                id: row.get(0)?,
                project: row.get(1)?,
                alert_id: row.get(2)?,
                alert_fingerprint: row.get(3)?,
                alert_title: row.get(4)?,
                predicted_diagnosis: row.get(5)?,
                predicted_files: files,
                predicted_fix_approach: row.get(7)?,
                confidence: row.get(8)?,
                created_at: DateTime::parse_from_rfc3339(&created_str)
                    .map(|t| t.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
                human_fix_detected: row.get::<_, i64>(10)? != 0,
                human_fix_matched: row.get::<_, i64>(11)? != 0,
                human_fix_files: human_files,
                resolved_at: resolved_str.and_then(|s|
                    DateTime::parse_from_rfc3339(&s).ok().map(|t| t.with_timezone(&Utc))),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn resolve_shadow(
    conn: &Connection,
    id: &str,
    human_files: Option<&[String]>,
    matched: bool,
) -> Result<()> {
    let hf = human_files.map(|f| serde_json::to_string(f).unwrap_or_default());
    conn.execute(
        "UPDATE shadow_predictions
         SET human_fix_detected = 1, human_fix_matched = ?1,
             human_fix_files = ?2, resolved_at = ?3
         WHERE id = ?4",
        params![matched as i64, hf, Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

// ── Outcome tracking ─────────────────────────────────────────────────────

/// Check if an alert with the same fingerprint was created after the given time.
/// Excludes the alert with `exclude_id` (the original alert that triggered the fix).
pub fn has_alert_with_fingerprint_since(
    conn: &Connection,
    fingerprint: &str,
    since: DateTime<Utc>,
    exclude_id: &str,
) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM alerts WHERE fingerprint = ?1 AND created_at > ?2 AND id != ?3",
        params![fingerprint, since.to_rfc3339(), exclude_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Adjust the confidence of an incident memory by a delta (positive or negative).
/// Clamps to [0, 100].
pub fn update_memory_confidence(conn: &Connection, id: &str, delta: i64) -> Result<()> {
    conn.execute(
        "UPDATE incident_memory SET confidence = MAX(0, MIN(100, confidence + ?1)) WHERE id = ?2",
        params![delta, id],
    )?;
    Ok(())
}

/// Store the community fix ID on an incident memory (for outcome reporting).
pub fn set_memory_community_fix_id(conn: &Connection, id: &str, fix_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE incident_memory SET community_fix_id = ?1 WHERE id = ?2",
        params![fix_id, id],
    )?;
    Ok(())
}

// ── Pattern cache (Fix Replay) ───────────────────────────────────────────────

/// Get a cached community pattern response by fingerprint.
/// Returns None if not cached or if the cache is older than `max_age_secs`.
pub fn get_cached_pattern(conn: &Connection, fingerprint: &str, max_age_secs: i64) -> Result<Option<String>> {
    let result: rusqlite::Result<(String, String)> = conn.query_row(
        "SELECT pattern_data, fetched_at FROM pattern_cache WHERE fingerprint = ?1",
        params![fingerprint],
        |row| Ok((row.get(0)?, row.get(1)?)),
    );
    match result {
        Ok((data, fetched_at)) => {
            let fetched = DateTime::parse_from_rfc3339(&fetched_at)
                .map(|t| t.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
            let age = Utc::now().signed_duration_since(fetched).num_seconds();
            if age <= max_age_secs {
                Ok(Some(data))
            } else {
                Ok(None) // expired
            }
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Cache a community pattern API response.
pub fn cache_pattern(conn: &Connection, fingerprint: &str, pattern_data: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO pattern_cache (fingerprint, pattern_data, fetched_at)
         VALUES (?1, ?2, ?3)",
        params![fingerprint, pattern_data, now],
    )?;
    Ok(())
}

/// Stats for Fix Replay feature usage.
pub struct FixReplayStats {
    pub cache_entries: u64,
    pub fingerprint_matches: u64,
    pub contributions: u64,
}

/// Get Fix Replay stats: cache size, fingerprint match count, contribution count.
pub fn get_fix_replay_stats(conn: &Connection, project: &str) -> Result<FixReplayStats> {
    let cache_entries: u64 = conn
        .query_row("SELECT COUNT(*) FROM pattern_cache", [], |r| r.get(0))
        .unwrap_or(0);

    let fingerprint_matches: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM incident_memory WHERE project = ?1 AND fingerprint IS NOT NULL AND fix_worked = 1",
            params![project],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let contributions: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM incident_memory WHERE project = ?1 AND fix_worked = 1",
            params![project],
            |r| r.get(0),
        )
        .unwrap_or(0);

    Ok(FixReplayStats { cache_entries, fingerprint_matches, contributions })
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
        fingerprint: row.get(10)?,
        postmortem_text: row.get(11).ok(),
        community_fix_id: row.get(12).ok().flatten(),
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
        fingerprint: row.get(9).ok().flatten(),
    })
}
