//! Integration test for the Training Loop (Sprint 8).
//!
//! Tests the full cycle: fingerprint → alert → fix → feedback → confidence adjustment.
//! Uses an in-memory SQLite database — no external services needed.

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use rusqlite::Connection;

    use crate::db::{self, Alert, IncidentMemory, PendingFeedback, ShadowPrediction};
    use crate::mcp::fingerprint::compute_error_fingerprint;

    /// Read a single memory row by ID (works regardless of fix_worked status).
    fn get_memory_by_id(conn: &Connection, id: &str) -> IncidentMemory {
        let mut stmt = conn.prepare(
            "SELECT id, project, alert_title, root_cause, fix_summary, files_fixed,
                    fix_worked, confidence, pr_url, created_at, fingerprint, postmortem_text, community_fix_id
             FROM incident_memory WHERE id = ?1",
        ).unwrap();
        stmt.query_row(rusqlite::params![id], |row| {
            let files_str: String = row.get(5)?;
            let files: Vec<String> = serde_json::from_str(&files_str).unwrap_or_default();
            let created_str: String = row.get(9)?;
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
                created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
                    .map(|t| t.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
                fingerprint: row.get(10).ok().flatten(),
                postmortem_text: row.get(11).ok().flatten(),
                community_fix_id: row.get(12).ok().flatten(),
            })
        }).unwrap()
    }

    /// Open an in-memory DB with all migrations applied.
    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // Run the same migrations as production
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY, project TEXT NOT NULL, integration TEXT NOT NULL,
                event_type TEXT NOT NULL, payload TEXT NOT NULL, fingerprint TEXT UNIQUE,
                occurred_at TEXT NOT NULL, processed_at TEXT, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS alerts (
                id TEXT PRIMARY KEY, project TEXT NOT NULL, severity TEXT NOT NULL,
                title TEXT NOT NULL, body TEXT NOT NULL, source_integrations TEXT NOT NULL,
                is_read INTEGER NOT NULL DEFAULT 0, sent_at TEXT, created_at TEXT NOT NULL,
                fingerprint TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_alerts_project ON alerts(project, created_at DESC);
            CREATE TABLE IF NOT EXISTS incident_memory (
                id TEXT PRIMARY KEY, project TEXT NOT NULL, alert_title TEXT NOT NULL,
                root_cause TEXT NOT NULL, fix_summary TEXT NOT NULL, files_fixed TEXT NOT NULL,
                fix_worked INTEGER NOT NULL DEFAULT 1, confidence INTEGER NOT NULL DEFAULT 0,
                pr_url TEXT, created_at TEXT NOT NULL, fingerprint TEXT, postmortem_text TEXT,
                community_fix_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_memory_project
                ON incident_memory(project, fix_worked, created_at DESC);
            CREATE TABLE IF NOT EXISTS pending_feedback (
                id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, project TEXT NOT NULL,
                alert_title TEXT NOT NULL, pr_url TEXT, fix_summary TEXT NOT NULL,
                created_at TEXT NOT NULL, answered INTEGER NOT NULL DEFAULT 0,
                answer INTEGER, community_fix_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_feedback_pending
                ON pending_feedback(answered, created_at DESC);
            CREATE TABLE IF NOT EXISTS shadow_predictions (
                id TEXT PRIMARY KEY, project TEXT NOT NULL, alert_id TEXT NOT NULL,
                alert_fingerprint TEXT, alert_title TEXT NOT NULL,
                predicted_diagnosis TEXT NOT NULL, predicted_files TEXT NOT NULL,
                predicted_fix_approach TEXT NOT NULL,
                confidence INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
                human_fix_detected INTEGER NOT NULL DEFAULT 0,
                human_fix_matched INTEGER NOT NULL DEFAULT 0,
                human_fix_files TEXT, resolved_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_shadow_project
                ON shadow_predictions(project, alert_fingerprint, created_at DESC);
            CREATE TABLE IF NOT EXISTS pattern_cache (
                fingerprint TEXT PRIMARY KEY, pattern_data TEXT NOT NULL, fetched_at TEXT NOT NULL
            );
            ",
        )
        .unwrap();
        conn
    }

    fn make_alert(id: &str, title: &str, body: &str, fingerprint: Option<&str>) -> Alert {
        Alert {
            id: id.to_string(),
            project: "test-project".to_string(),
            severity: "critical".to_string(),
            title: title.to_string(),
            body: body.to_string(),
            source_integrations: vec!["sentry".to_string()],
            is_read: false,
            sent_at: None,
            created_at: Utc::now(),
            fingerprint: fingerprint.map(String::from),
        }
    }

    fn make_memory(id: &str, title: &str, confidence: i64, fingerprint: Option<&str>) -> IncidentMemory {
        IncidentMemory {
            id: id.to_string(),
            project: "test-project".to_string(),
            alert_title: title.to_string(),
            root_cause: "null pointer in user lookup".to_string(),
            fix_summary: "added null check before accessing user.email".to_string(),
            files_fixed: vec!["src/handlers/user.rs".to_string()],
            fix_worked: true,
            confidence,
            pr_url: Some("https://github.com/test/repo/pull/42".to_string()),
            created_at: Utc::now(),
            fingerprint: fingerprint.map(String::from),
            postmortem_text: None,
            community_fix_id: None,
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 1. FINGERPRINT DETERMINISM
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn fingerprint_is_deterministic_across_noise() {
        // Same logical error with different timestamps and UUIDs → same fingerprint
        let fp1 = compute_error_fingerprint(
            "TypeError: Cannot read property 'email' of null",
            "request a1b2c3d4-e5f6-7890-abcd-ef1234567890 at 2024-01-15T10:30:00Z",
        );
        let fp2 = compute_error_fingerprint(
            "TypeError: Cannot read property 'email' of null",
            "request 11111111-2222-3333-4444-555555555555 at 2026-03-24T15:00:00Z",
        );
        assert_eq!(fp1, fp2, "Same error class should produce same fingerprint");
    }

    #[test]
    fn fingerprint_differs_for_different_errors() {
        let fp1 = compute_error_fingerprint("TypeError: x is null", "at render()");
        let fp2 = compute_error_fingerprint("SyntaxError: unexpected token", "at parse()");
        assert_ne!(fp1, fp2, "Different errors must produce different fingerprints");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 2. ALERT WITH FINGERPRINT — INSERT + QUERY
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn alert_stores_and_retrieves_fingerprint() {
        let conn = test_db();
        let fp = compute_error_fingerprint("TypeError: x is null", "at render()");
        let alert = make_alert("alert-1", "TypeError: x is null", "at render()", Some(&fp));

        db::insert_alert(&conn, &alert).unwrap();

        let alerts = db::get_recent_alerts(&conn, Some("test-project"), 10).unwrap();
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].fingerprint.as_deref(), Some(fp.as_str()));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 3. OUTCOME TRACKING — RECURRENCE DETECTION
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn detects_recurrence_by_fingerprint() {
        let conn = test_db();
        let fp = compute_error_fingerprint("TypeError: x is null", "at render()");

        // Original alert (the one that triggered the fix)
        let alert1 = make_alert("alert-original", "TypeError: x is null", "at render()", Some(&fp));
        db::insert_alert(&conn, &alert1).unwrap();

        // Same error recurs 20 min later
        let mut alert2 = make_alert("alert-recurrence", "TypeError: x is null", "at render()", Some(&fp));
        alert2.created_at = Utc::now();
        db::insert_alert(&conn, &alert2).unwrap();

        let since = Utc::now() - Duration::hours(1);
        let recurred = db::has_alert_with_fingerprint_since(&conn, &fp, since, "alert-original").unwrap();
        assert!(recurred, "Should detect recurrence of same fingerprint");
    }

    #[test]
    fn no_false_recurrence_without_matching_fingerprint() {
        let conn = test_db();
        let fp1 = compute_error_fingerprint("TypeError: x is null", "at render()");
        let fp2 = compute_error_fingerprint("SyntaxError: unexpected token", "at parse()");

        let alert1 = make_alert("alert-1", "TypeError", "render", Some(&fp1));
        let alert2 = make_alert("alert-2", "SyntaxError", "parse", Some(&fp2));
        db::insert_alert(&conn, &alert1).unwrap();
        db::insert_alert(&conn, &alert2).unwrap();

        let since = Utc::now() - Duration::hours(1);
        let recurred = db::has_alert_with_fingerprint_since(&conn, &fp1, since, "alert-1").unwrap();
        assert!(!recurred, "Different fingerprint should not trigger recurrence");
    }

    #[test]
    fn excludes_original_alert_from_recurrence_check() {
        let conn = test_db();
        let fp = compute_error_fingerprint("TypeError: x is null", "at render()");

        let alert = make_alert("alert-only", "TypeError", "render", Some(&fp));
        db::insert_alert(&conn, &alert).unwrap();

        let since = Utc::now() - Duration::hours(1);
        let recurred = db::has_alert_with_fingerprint_since(&conn, &fp, since, "alert-only").unwrap();
        assert!(!recurred, "Original alert should be excluded from recurrence");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 4. CONFIDENCE ADJUSTMENT
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn confidence_increases_on_success() {
        let conn = test_db();
        let mem = make_memory("mem-1", "TypeError", 60, None);
        db::save_incident_memory(&conn, &mem).unwrap();

        db::update_memory_confidence(&conn, "mem-1", 5).unwrap();

        let mem = get_memory_by_id(&conn, "mem-1");
        assert_eq!(mem.confidence, 65);
    }

    #[test]
    fn confidence_decreases_on_failure() {
        let conn = test_db();
        let mem = make_memory("mem-2", "TypeError", 60, None);
        db::save_incident_memory(&conn, &mem).unwrap();

        db::update_memory_confidence(&conn, "mem-2", -20).unwrap();

        let mem = get_memory_by_id(&conn, "mem-2");
        assert_eq!(mem.confidence, 40);
    }

    #[test]
    fn confidence_clamps_to_zero() {
        let conn = test_db();
        let mem = make_memory("mem-3", "TypeError", 10, None);
        db::save_incident_memory(&conn, &mem).unwrap();

        db::update_memory_confidence(&conn, "mem-3", -50).unwrap();

        let mem = get_memory_by_id(&conn, "mem-3");
        assert_eq!(mem.confidence, 0, "Confidence should clamp to 0");
    }

    #[test]
    fn confidence_clamps_to_100() {
        let conn = test_db();
        let mem = make_memory("mem-4", "TypeError", 95, None);
        db::save_incident_memory(&conn, &mem).unwrap();

        db::update_memory_confidence(&conn, "mem-4", 20).unwrap();

        let mem = get_memory_by_id(&conn, "mem-4");
        assert_eq!(mem.confidence, 100, "Confidence should clamp to 100");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 5. FULL TRAINING LOOP SIMULATION
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn full_loop_fix_succeeds() {
        let conn = test_db();
        let fp = compute_error_fingerprint("TypeError: Cannot read 'email' of null", "at UserService");

        // Step 1: Alert arrives with fingerprint
        let alert = make_alert("alert-A", "TypeError: Cannot read 'email' of null", "at UserService", Some(&fp));
        db::insert_alert(&conn, &alert).unwrap();

        // Step 2: Fix is applied, memory saved with initial confidence
        let mem = make_memory("mem-A", "TypeError: Cannot read 'email' of null", 72, Some(&fp));
        db::save_incident_memory(&conn, &mem).unwrap();

        // Step 3: Feedback is queued
        let fb = PendingFeedback {
            id: "fb-A".to_string(),
            memory_id: "mem-A".to_string(),
            project: "test-project".to_string(),
            alert_title: "TypeError: Cannot read 'email' of null".to_string(),
            pr_url: Some("https://github.com/test/repo/pull/42".to_string()),
            fix_summary: "Added null check before accessing user.email".to_string(),
            created_at: Utc::now(),
            answered: false,
            answer: None,
            community_fix_id: None,
        };
        db::save_pending_feedback(&conn, &fb).unwrap();
        assert_eq!(db::count_pending_feedback(&conn), 1);

        // Step 4: 30 min pass — no recurrence detected
        let since = Utc::now() - Duration::minutes(30);
        let recurred = db::has_alert_with_fingerprint_since(&conn, &fp, since, "alert-A").unwrap();
        assert!(!recurred);

        // Extended monitor: boost confidence
        db::update_memory_confidence(&conn, "mem-A", 5).unwrap();

        // Step 5: User confirms fix worked
        db::answer_feedback(&conn, "fb-A", true).unwrap();
        assert_eq!(db::count_pending_feedback(&conn), 0);

        // Verify final state
        let mem = get_memory_by_id(&conn, "mem-A");
        assert_eq!(mem.confidence, 77); // 72 + 5
        assert!(mem.fix_worked);
    }

    #[test]
    fn full_loop_fix_fails_and_recurs() {
        let conn = test_db();
        let fp = compute_error_fingerprint("OutOfMemory in worker pool", "heap exhausted");

        // Step 1: Alert arrives
        let alert1 = make_alert("alert-B1", "OutOfMemory in worker pool", "heap exhausted", Some(&fp));
        db::insert_alert(&conn, &alert1).unwrap();

        // Step 2: Fix is applied
        let mem = make_memory("mem-B", "OutOfMemory in worker pool", 65, Some(&fp));
        db::save_incident_memory(&conn, &mem).unwrap();

        // Step 3: Feedback queued
        let fb = PendingFeedback {
            id: "fb-B".to_string(),
            memory_id: "mem-B".to_string(),
            project: "test-project".to_string(),
            alert_title: "OutOfMemory in worker pool".to_string(),
            pr_url: Some("https://github.com/test/repo/pull/43".to_string()),
            fix_summary: "Increased pool size".to_string(),
            created_at: Utc::now(),
            answered: false,
            answer: None,
            community_fix_id: None,
        };
        db::save_pending_feedback(&conn, &fb).unwrap();

        // Step 4: Same error recurs!
        let alert2 = make_alert("alert-B2", "OutOfMemory in worker pool", "heap exhausted", Some(&fp));
        db::insert_alert(&conn, &alert2).unwrap();

        let since = Utc::now() - Duration::hours(1);
        let recurred = db::has_alert_with_fingerprint_since(&conn, &fp, since, "alert-B1").unwrap();
        assert!(recurred, "Recurrence should be detected");

        // Extended monitor: mark failed, decrease confidence
        db::mark_memory_failed(&conn, "mem-B").unwrap();
        db::update_memory_confidence(&conn, "mem-B", -20).unwrap();

        // Step 5: User confirms fix failed
        db::answer_feedback(&conn, "fb-B", false).unwrap();

        // Verify final state
        let mem = get_memory_by_id(&conn, "mem-B");
        assert_eq!(mem.confidence, 45); // 65 - 20
        assert!(!mem.fix_worked);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 6. PENDING FEEDBACK CRUD
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn pending_feedback_lifecycle() {
        let conn = test_db();

        // Initially empty
        assert_eq!(db::count_pending_feedback(&conn), 0);
        let pending = db::get_pending_feedback(&conn, 10).unwrap();
        assert!(pending.is_empty());

        // Add 3 feedback requests
        for i in 1..=3 {
            let fb = PendingFeedback {
                id: format!("fb-{}", i),
                memory_id: format!("mem-{}", i),
                project: "test-project".to_string(),
                alert_title: format!("Error #{}", i),
                pr_url: None,
                fix_summary: format!("Fix #{}", i),
                created_at: Utc::now(),
                answered: false,
                answer: None,
                community_fix_id: None,
            };
            db::save_pending_feedback(&conn, &fb).unwrap();
        }

        assert_eq!(db::count_pending_feedback(&conn), 3);

        // Answer one
        db::answer_feedback(&conn, "fb-2", true).unwrap();
        assert_eq!(db::count_pending_feedback(&conn), 2);

        // Only unanswered come back
        let pending = db::get_pending_feedback(&conn, 10).unwrap();
        assert_eq!(pending.len(), 2);
        assert!(pending.iter().all(|f| f.id != "fb-2"));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 7. SHADOW PREDICTIONS
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn shadow_prediction_save_and_resolve() {
        let conn = test_db();
        let fp = compute_error_fingerprint("ReferenceError: foo", "at bar()");

        // Save prediction
        let pred = ShadowPrediction {
            id: "shadow-1".to_string(),
            project: "test-project".to_string(),
            alert_id: "alert-S1".to_string(),
            alert_fingerprint: Some(fp.clone()),
            alert_title: "ReferenceError: foo".to_string(),
            predicted_diagnosis: "Variable foo is used before declaration".to_string(),
            predicted_files: vec!["src/utils.ts".to_string(), "src/index.ts".to_string()],
            predicted_fix_approach: "Move declaration above usage".to_string(),
            confidence: 78,
            created_at: Utc::now(),
            human_fix_detected: false,
            human_fix_matched: false,
            human_fix_files: None,
            resolved_at: None,
        };
        db::save_shadow_prediction(&conn, &pred).unwrap();

        // Unresolved returns it
        let unresolved = db::get_unresolved_shadows(&conn, "test-project", 10).unwrap();
        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0].predicted_files, vec!["src/utils.ts", "src/index.ts"]);

        // Resolve with human's fix (50% file overlap = match)
        let human_files = vec!["src/utils.ts".to_string(), "src/helpers.ts".to_string()];
        db::resolve_shadow(&conn, "shadow-1", Some(&human_files), true).unwrap();

        // No longer in unresolved
        let unresolved = db::get_unresolved_shadows(&conn, "test-project", 10).unwrap();
        assert!(unresolved.is_empty());
    }

    #[test]
    fn shadow_prediction_wrong_project_not_returned() {
        let conn = test_db();

        let pred = ShadowPrediction {
            id: "shadow-2".to_string(),
            project: "other-project".to_string(),
            alert_id: "alert-S2".to_string(),
            alert_fingerprint: None,
            alert_title: "Error".to_string(),
            predicted_diagnosis: "diag".to_string(),
            predicted_files: vec![],
            predicted_fix_approach: "fix".to_string(),
            confidence: 50,
            created_at: Utc::now(),
            human_fix_detected: false,
            human_fix_matched: false,
            human_fix_files: None,
            resolved_at: None,
        };
        db::save_shadow_prediction(&conn, &pred).unwrap();

        let unresolved = db::get_unresolved_shadows(&conn, "test-project", 10).unwrap();
        assert!(unresolved.is_empty(), "Shadow from other project should not appear");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 8. COMMUNITY FIX ID TRACKING
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn community_fix_id_stored_on_memory() {
        let conn = test_db();
        let mem = make_memory("mem-C", "Build failed", 80, None);
        db::save_incident_memory(&conn, &mem).unwrap();

        // Initially no community fix ID
        let mem = get_memory_by_id(&conn, "mem-C");
        assert!(mem.community_fix_id.is_none());

        // Set it after contributing to community
        db::set_memory_community_fix_id(&conn, "mem-C", "cf-abc123").unwrap();

        let mem = get_memory_by_id(&conn, "mem-C");
        assert_eq!(mem.community_fix_id.as_deref(), Some("cf-abc123"));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 9. TRUST LEVEL EVOLUTION WITH TRAINING LOOP
    // ═══════════════════════════════════════════════════════════════════════

    #[test]
    fn trust_level_progresses_with_successful_fixes() {
        let conn = test_db();

        // Simulate 10 fixes — 9 successful (90% rate)
        for i in 0..10 {
            let worked = i != 5; // one failure at fix #5
            let mut mem = make_memory(
                &format!("trust-mem-{}", i),
                &format!("Error #{}", i),
                if worked { 85 } else { 30 },
                None,
            );
            mem.fix_worked = worked;
            db::save_incident_memory(&conn, &mem).unwrap();
        }

        let rec = db::get_track_record(&conn, "test-project").unwrap();
        assert_eq!(rec.total, 10);
        assert_eq!(rec.succeeded, 9);
        assert_eq!(rec.failed, 1);
        assert_eq!(rec.trust_level, db::TrustLevel::Expert); // >= 10 fixes, >= 85% success
    }

    #[test]
    fn training_loop_degrades_trust_on_failures() {
        let conn = test_db();

        // Start with 5 successful fixes → Trusted level
        for i in 0..5 {
            let mem = make_memory(
                &format!("degrade-mem-{}", i),
                &format!("Error #{}", i),
                80,
                None,
            );
            db::save_incident_memory(&conn, &mem).unwrap();
        }

        let rec = db::get_track_record(&conn, "test-project").unwrap();
        assert_eq!(rec.trust_level, db::TrustLevel::Trusted); // 5 fixes, 100% success

        // Now add 3 failures via training loop (mark_memory_failed)
        for i in 0..3 {
            let mem = make_memory(
                &format!("fail-mem-{}", i),
                &format!("Failed #{}", i),
                40,
                None,
            );
            db::save_incident_memory(&conn, &mem).unwrap();
            db::mark_memory_failed(&conn, &format!("fail-mem-{}", i)).unwrap();
        }

        let rec = db::get_track_record(&conn, "test-project").unwrap();
        assert_eq!(rec.total, 8);
        assert_eq!(rec.succeeded, 5);
        assert_eq!(rec.failed, 3);
        // 62.5% success rate with 8 fixes — should be Trusted (>= 5 fixes, but check thresholds)
        // Actually 62.5% < 70%, so drops to Apprentice
        assert_eq!(rec.trust_level, db::TrustLevel::Apprentice);
    }
}
