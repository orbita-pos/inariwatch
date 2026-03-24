use chrono::Utc;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::ai;
use crate::ai::prompts::{MemoryHint, RemediationContext};
use crate::config;
use crate::db;
use crate::integrations::github::{CIStatus, GitHubClient};
use crate::integrations::sentry::SentryClient;
use crate::integrations::vercel::VercelClient;
use crate::mcp::escalation;
use crate::mcp::fingerprint;
use crate::mcp::progress::Step;
use crate::mcp::safety;

pub async fn execute(args: &Value) -> anyhow::Result<String> {
    let alert_id = args["alert_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("alert_id is required"))?;
    let auto_merge = args["auto_merge"].as_bool().unwrap_or(false);
    let max_attempts = args["max_attempts"].as_u64().unwrap_or(2).min(3).max(1) as usize;
    let dry_run = args["dry_run"].as_bool().unwrap_or(false);

    let mut steps: Vec<Step> = Vec::new();
    let mut files_changed: Vec<String>;

    // ── Step 1: Validate ──────────────────────────────────────────────────

    let conn = db::open()?;
    let alert = db::get_alert_by_id(&conn, alert_id)?
        .ok_or_else(|| anyhow::anyhow!("Alert not found: {}", alert_id))?;

    // Compute error fingerprint for fix replay matching
    let alert_fingerprint = fingerprint::compute_error_fingerprint(&alert.title, &alert.body);

    // Load incident memories + track record before closing the connection
    let project_slug_for_mem = alert.project.clone();
    let alert_title_for_mem = alert.title.clone();
    let raw_memories = db::get_relevant_memories(
        &conn, &project_slug_for_mem, &alert_title_for_mem,
        Some(&alert_fingerprint), 3,
    ).unwrap_or_default();
    let track = db::get_track_record(&conn, &project_slug_for_mem).unwrap_or_else(|_| db::TrackRecord {
        total: 0, succeeded: 0, failed: 0, success_rate: 0.0,
        avg_confidence: 0.0, auto_merged: 0,
        trust_level: db::TrustLevel::Rookie,
        recent: vec![],
    });
    let memory_id = Uuid::new_v4().to_string();
    drop(conn);

    let cfg = config::load()?;
    let ai_key = cfg.global.ai_key.as_ref().ok_or_else(|| {
        anyhow::anyhow!("No AI key configured. Run `inariwatch config --ai-key <key>`")
    })?;

    // Resolve project
    let project_slug = args["project"]
        .as_str()
        .unwrap_or(&alert.project);
    let project = cfg
        .projects
        .iter()
        .find(|p| p.slug == project_slug || p.name == project_slug)
        .ok_or_else(|| anyhow::anyhow!("Project '{}' not found in config", project_slug))?;

    let gh_config = project.integrations.github.as_ref().ok_or_else(|| {
        anyhow::anyhow!("No GitHub integration configured for project '{}'", project.name)
    })?;

    let gh = GitHubClient::new(gh_config);

    // Check write permissions
    let can_push = gh.check_write_permissions().await?;
    if !can_push {
        return Ok(fail_result(
            &steps,
            "GitHub token does not have push access. Need a token with 'repo' scope.",
        ));
    }

    steps.push(Step::ok("validate", format!(
        "Project: {}, GitHub: {}, AI: configured, Trust: {} (level {})",
        project.name, gh_config.repo,
        track.trust_level.name(), track.trust_level.level()
    )));

    // ── Step 2: Diagnose ──────────────────────────────────────────────────

    let default_branch = gh.get_default_branch().await?;
    let base_sha = gh.get_branch_sha(&default_branch).await?;

    // Get repo file tree
    let all_files = gh.get_repo_tree(&base_sha).await?;
    let repo_files: Vec<String> = all_files
        .into_iter()
        .filter(|f| {
            !f.contains("node_modules/")
                && !f.starts_with(".git/")
                && !f.contains(".lock")
                && !f.ends_with(".lockb")
        })
        .take(500)
        .collect();

    // Gather context in parallel
    let mut context = RemediationContext::default();

    let sentry_fut = async {
        if let Some(sentry_cfg) = &project.integrations.sentry {
            let client = SentryClient::new(sentry_cfg);
            if let Ok(issues) = client.get_new_issues(24).await {
                for issue in &issues {
                    if alert.title.contains(&issue.title) || issue.title.contains(&alert.title) {
                        let trace = client.get_issue_latest_event(&issue.id).await.ok().flatten();
                        let details = client.get_issue_details(&issue.id).await.ok().flatten();
                        return Some((trace, details));
                    }
                }
            }
        }
        None
    };

    let vercel_fut = async {
        if let Some(vercel_cfg) = &project.integrations.vercel {
            let client = VercelClient::new(vercel_cfg);
            if let Ok(failed) = client.get_failed_deployments(&vercel_cfg.project_id, 6).await {
                if let Some(dep) = failed.first() {
                    if let Ok((_, summary)) = client.get_deployment_events(&dep.uid).await {
                        return Some(summary);
                    }
                }
            }
        }
        None
    };

    let github_ci_fut = async {
        if let Ok(failures) = gh.get_recent_failures(3).await {
            if let Some(run) = failures.first() {
                if let Some(branch) = &run.head_branch {
                    if let Ok(logs) = gh.get_failed_check_logs(branch).await {
                        return Some(logs);
                    }
                }
            }
        }
        None
    };

    let (sentry_result, vercel_result, github_result) =
        tokio::join!(sentry_fut, vercel_fut, github_ci_fut);
    if let Some((trace, details)) = sentry_result {
        context.sentry_stack_trace = trace;
        context.sentry_issue_details = details;
    }
    context.vercel_build_logs = vercel_result;
    context.github_ci_logs = github_result;

    // Convert DB memories to prompt hints
    let past_hints: Vec<MemoryHint> = raw_memories
        .iter()
        .map(|m| MemoryHint {
            alert_title: m.alert_title.clone(),
            root_cause: m.root_cause.clone(),
            fix_summary: m.fix_summary.clone(),
            files_fixed: m.files_fixed.clone(),
            confidence: m.confidence,
        })
        .collect();

    // ── Fix Replay: query community patterns from web API ──────────
    let mut past_hints = past_hints;

    if cfg.global.fix_replay {
        if let Some(base_url) = &cfg.global.fix_replay_url {
            match query_fix_replay(&alert_fingerprint, &alert.title, base_url).await {
                Ok(Some(community_hints)) => {
                    let count = community_hints.len();
                    past_hints.extend(community_hints);
                    steps.push(Step::ok(
                        "fix_replay",
                        format!("Found {} community fix(es) from Fix Replay API", count),
                    ));
                }
                Ok(None) => {} // no matches
                Err(e) => {
                    steps.push(Step::ok(
                        "fix_replay",
                        format!("Fix Replay query failed (non-blocking): {}", e),
                    ));
                }
            }
        }
    }

    if !past_hints.is_empty() {
        let is_fp_match = raw_memories.iter().any(|m| {
            m.fingerprint.as_deref() == Some(alert_fingerprint.as_str())
                && m.confidence >= 80
        });
        let msg = if is_fp_match {
            format!(
                "Exact fingerprint match — replaying {} past fix(es) (confidence: {}%)",
                past_hints.len(),
                raw_memories[0].confidence,
            )
        } else {
            format!("Found {} similar past incident(s) — injecting into diagnosis", past_hints.len())
        };
        steps.push(Step::ok("memory", msg));
    }

    let model = Some(cfg.global.ai_model.as_str());
    let diagnosis_result = ai::diagnose(
        ai_key,
        model,
        &alert.title,
        &alert.body,
        &alert.source_integrations,
        &repo_files,
        &context,
        alert.body.lines().next(),
        &past_hints,
    )
    .await?;

    let diagnosis = diagnosis_result["diagnosis"]
        .as_str()
        .unwrap_or("Unable to determine root cause")
        .to_string();
    let confidence = diagnosis_result["confidence"].as_u64().unwrap_or(0) as u32;
    let files_to_read: Vec<String> = diagnosis_result["filesToRead"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // Confidence gate
    if confidence < safety::CONFIDENCE_ABORT {
        steps.push(Step::fail("diagnose", format!(
            "Confidence too low ({}%) to proceed. Diagnosis: {}",
            confidence, diagnosis
        )).with_score(confidence));
        // Escalate via Telegram
        let _ = escalation::escalate(&escalation::EscalationContext {
            alert_title: alert.title.clone(),
            project: project.name.clone(),
            reason: "Confidence too low to proceed".to_string(),
            diagnosis: Some(diagnosis.clone()),
            confidence: Some(confidence),
            attempts: None,
            max_attempts: None,
            ci_error: None,
            pr_url: None,
            branch: None,
        }).await;
        return Ok(abort_result(&steps, confidence, &diagnosis));
    }

    steps.push(
        Step::ok("diagnose", format!(
            "{}. Files to read: {}",
            diagnosis,
            files_to_read.join(", ")
        ))
        .with_score(confidence),
    );

    // ── Step 3: Read Code ─────────────────────────────────────────────────

    let mut file_contents: Vec<(String, String)> = Vec::new();
    let mut blocked_files: Vec<String> = Vec::new();

    for path in files_to_read.iter().take(5) {
        if !safety::is_safe_file_path(path) {
            let reason = safety::blocked_reason(path).unwrap_or("blocked");
            blocked_files.push(format!("{} ({})", path, reason));
            continue;
        }
        match gh.get_file_content(path, Some(&base_sha)).await {
            Ok(Some(content)) => file_contents.push((path.clone(), content)),
            Ok(None) => {} // File not found, skip
            Err(_) => {}   // API error, skip
        }
    }

    if file_contents.is_empty() {
        steps.push(Step::fail(
            "read_code",
            "Could not read any of the identified files.",
        ));
        return Ok(fail_result(&steps, "No source files could be read from the repository."));
    }

    let blocked_note = if blocked_files.is_empty() {
        String::new()
    } else {
        format!(" (blocked: {})", blocked_files.join(", "))
    };
    steps.push(Step::ok(
        "read_code",
        format!("Read {} file(s){}", file_contents.len(), blocked_note),
    ));

    // ── Steps 4-5: Generate Fix + Self-Review (attempt loop) ──────────────

    let error_details = format!("{}\n{}", alert.title, alert.body);
    let mut fix_files: Vec<(String, String)> = Vec::new();
    let mut fix_explanation = String::new();
    let mut review_score: u32 = 0;
    let mut review_recommendation = String::new();

    let mut prev_attempt_paths: Vec<String> = Vec::new();
    let mut prev_ci_error = String::new();

    for attempt in 1..=max_attempts {
        // Step 4: Generate Fix
        let file_refs: Vec<(&str, &str)> = file_contents
            .iter()
            .map(|(p, c)| (p.as_str(), c.as_str()))
            .collect();

        let previous = if attempt > 1 {
            Some((prev_attempt_paths.as_slice(), prev_ci_error.as_str()))
        } else {
            None
        };

        let fix_result =
            ai::generate_fix(ai_key, model, &diagnosis, &file_refs, &error_details, previous)
                .await?;

        fix_explanation = fix_result["explanation"]
            .as_str()
            .unwrap_or("")
            .to_string();

        fix_files = fix_result["files"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|f| {
                        let path = f["path"].as_str()?;
                        let content = f["content"].as_str()?;
                        Some((path.to_string(), content.to_string()))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        // Filter out blocked files
        fix_files.retain(|(path, _)| safety::is_safe_file_path(path));

        if fix_files.is_empty() {
            steps.push(Step::fail(
                "generate_fix",
                format!("Attempt {}: AI generated no safe files to modify.", attempt),
            ));
            if attempt == max_attempts {
                return Ok(fail_result(&steps, "AI could not generate any safe file modifications."));
            }
            continue;
        }

        steps.push(Step::ok(
            "generate_fix",
            format!(
                "Attempt {}: {}. Files: {}",
                attempt,
                fix_explanation,
                fix_files.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>().join(", ")
            ),
        ));

        // Step 5: Self-Review
        let original_refs: Vec<(&str, &str)> = file_contents
            .iter()
            .map(|(p, c)| (p.as_str(), c.as_str()))
            .collect();
        let fixed_refs: Vec<(&str, &str)> = fix_files
            .iter()
            .map(|(p, c)| (p.as_str(), c.as_str()))
            .collect();

        let review_result =
            ai::self_review(ai_key, model, &diagnosis, &original_refs, &fixed_refs, &error_details)
                .await?;

        review_score = review_result["score"].as_u64().unwrap_or(0) as u32;
        review_recommendation = review_result["recommendation"]
            .as_str()
            .unwrap_or("flag")
            .to_string();
        let concerns: Vec<String> = review_result["concerns"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();

        if review_recommendation == "reject" && attempt == max_attempts {
            steps.push(
                Step::fail(
                    "self_review",
                    format!(
                        "Score: {}/100, recommendation: reject. Concerns: {}",
                        review_score,
                        concerns.join("; ")
                    ),
                )
                .with_score(review_score),
            );
            return Ok(fail_result(&steps, "Self-review rejected the fix. Manual investigation needed."));
        }

        steps.push(
            Step::ok(
                "self_review",
                format!(
                    "Score: {}/100, recommendation: {}{}",
                    review_score,
                    review_recommendation,
                    if concerns.is_empty() {
                        String::new()
                    } else {
                        format!(". Concerns: {}", concerns.join("; "))
                    }
                ),
            )
            .with_score(review_score),
        );

        // If review passed (not reject), break the attempt loop
        if review_recommendation != "reject" {
            break;
        }

        // Store for retry context
        prev_attempt_paths = fix_files.iter().map(|(p, _)| p.clone()).collect();
        prev_ci_error = format!("Self-review rejected: {}", concerns.join("; "));
    }

    files_changed = fix_files.iter().map(|(p, _)| p.clone()).collect();

    // ── Step 6: Dry Run Check ─────────────────────────────────────────────

    if dry_run {
        steps.push(Step::ok(
            "dry_run",
            "Dry run complete — no changes pushed.",
        ));
        return Ok(serde_json::to_string_pretty(&json!({
            "status": "dry_run",
            "steps": steps,
            "confidence": confidence,
            "diagnosis": diagnosis,
            "fix_explanation": fix_explanation,
            "files_changed": files_changed,
            "review_score": review_score,
            "proposed_changes": fix_files.iter().map(|(p, c)| json!({
                "path": p,
                "content_preview": if c.len() > 500 { format!("{}...", &c[..500]) } else { c.clone() }
            })).collect::<Vec<_>>(),
            "error": null
        }))?);
    }

    // ── Step 7: Push ──────────────────────────────────────────────────────

    let short_id: String = alert_id.chars().take(8).collect();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{:x}", d.as_secs()))
        .unwrap_or_else(|_| "0".to_string());
    let branch_name = format!("radar/fix-{}-{}", short_id, timestamp);

    let title_truncated: String = alert.title.chars().take(60).collect();
    let commit_message = format!(
        "fix: {}\n\nAutomated by InariWatch AI (confidence: {}%)",
        title_truncated, confidence
    );

    gh.create_branch(&branch_name, &base_sha).await?;

    let commit_files: Vec<(&str, &str)> = fix_files
        .iter()
        .map(|(p, c)| (p.as_str(), c.as_str()))
        .collect();

    let commit_sha = gh
        .commit_files(&branch_name, &commit_message, &commit_files)
        .await?;

    steps.push(Step::ok(
        "push",
        format!("Branch: {}, commit: {}", branch_name, &commit_sha[..8.min(commit_sha.len())]),
    ));

    // ── Step 8: Wait CI ───────────────────────────────────────────────────

    // Wait for GitHub to register the push
    tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;

    let ci_status = wait_for_ci(&gh, &commit_sha, 300).await; // 5 min max

    match &ci_status {
        CIWaitResult::Success(checks) => {
            steps.push(Step::ok(
                "ci_wait",
                format!("CI passed ({} checks)", checks),
            ));
        }
        CIWaitResult::NoChecks => {
            steps.push(Step::ok(
                "ci_wait",
                "No CI checks configured — proceeding.",
            ));
        }
        CIWaitResult::Failure => {
            // Try to get CI logs for context
            let ci_logs = gh
                .get_failed_check_logs(&branch_name)
                .await
                .unwrap_or_else(|_| "CI failed — no logs available.".to_string());

            steps.push(Step::fail("ci_wait", format!("CI failed: {}", &ci_logs[..ci_logs.len().min(200)])));

            // Note: a full implementation would retry (go back to step 4 with CI error context)
            // For v2 initial release, we create a draft PR noting the failure
            let pr_body = format!(
                "## InariWatch AI Fix\n\n\
                 **Alert:** {}\n\
                 **Diagnosis:** {}\n\
                 **Confidence:** {}%\n\
                 **Self-review:** {}/100\n\n\
                 **Note:** CI failed. Manual review required.\n\n\
                 CI output:\n```\n{}\n```\n\n\
                 ---\n*Automated by InariWatch*",
                alert.title,
                diagnosis,
                confidence,
                review_score,
                &ci_logs[..ci_logs.len().min(1000)]
            );

            let (pr_url, _pr_number) = gh
                .create_pr(
                    &format!("fix: {}", title_truncated),
                    &pr_body,
                    &branch_name,
                    &default_branch,
                    true, // draft
                )
                .await?;

            steps.push(Step::ok("create_pr", format!("Draft PR (CI failed): {}", pr_url)));

            // Escalate via Telegram
            let _ = escalation::escalate(&escalation::EscalationContext {
                alert_title: alert.title.clone(),
                project: project.name.clone(),
                reason: "CI failed after fix attempt".to_string(),
                diagnosis: Some(diagnosis.clone()),
                confidence: Some(confidence),
                attempts: Some(1),
                max_attempts: Some(max_attempts),
                ci_error: Some(ci_logs[..ci_logs.len().min(200)].to_string()),
                pr_url: Some(pr_url.clone()),
                branch: Some(branch_name.clone()),
            }).await;

            return Ok(serde_json::to_string_pretty(&json!({
                "status": "failed",
                "steps": steps,
                "pr_url": pr_url,
                "branch": branch_name,
                "confidence": confidence,
                "files_changed": files_changed,
                "error": "CI checks failed. Draft PR created for manual review."
            }))?);
        }
        CIWaitResult::Timeout => {
            steps.push(Step::ok(
                "ci_wait",
                "CI timed out (5 min) — proceeding with draft PR.",
            ));
        }
    }

    // ── Step 9: Create PR ─────────────────────────────────────────────────

    // Evaluate auto-merge gates — thresholds scale with trust level
    let min_conf   = track.trust_level.min_confidence();
    let min_review = track.trust_level.min_review_score();
    let max_lines  = track.trust_level.max_changed_lines();

    let gates_pass = auto_merge
        && matches!(ci_status, CIWaitResult::Success(_))
        && confidence >= min_conf
        && review_score >= min_review
        && review_recommendation != "reject"
        && count_changed_lines(&fix_files) <= max_lines;

    let is_draft = !gates_pass;

    // ── Generate post-mortem (non-blocking) ──────────────────────────
    let step_pairs: Vec<(String, String)> = steps
        .iter()
        .map(|s| (s.step.to_string(), s.message.clone()))
        .collect();

    let postmortem_text = match ai::generate_postmortem(
        ai_key,
        model,
        &alert.title,
        &alert.body,
        &alert.source_integrations,
        &diagnosis,
        &fix_explanation,
        &files_changed,
        confidence,
        None, // PR not created yet
        gates_pass,
        &step_pairs,
    )
    .await
    {
        Ok(text) => {
            steps.push(Step::ok("postmortem", "Post-mortem generated"));
            Some(text)
        }
        Err(_) => None,
    };

    let postmortem_section = postmortem_text
        .as_ref()
        .map(|pm| {
            format!(
                "\n\n<details>\n<summary>Post-mortem</summary>\n\n{}\n\n</details>",
                pm
            )
        })
        .unwrap_or_default();

    let pr_body = format!(
        "## InariWatch AI Fix\n\n\
         **Alert:** {}\n\
         **Diagnosis:** {}\n\
         **Confidence:** {}%\n\
         **Self-review:** {}/100 ({})\n\
         **Files changed:** {}\n\n\
         ### What changed\n{}\
         {}\n\n\
         ---\n*Automated by InariWatch*",
        alert.title,
        diagnosis,
        confidence,
        review_score,
        review_recommendation,
        files_changed.join(", "),
        fix_explanation,
        postmortem_section,
    );

    let (pr_url, pr_number) = gh
        .create_pr(
            &format!("fix: {}", title_truncated),
            &pr_body,
            &branch_name,
            &default_branch,
            is_draft,
        )
        .await?;

    steps.push(Step::ok(
        "create_pr",
        format!(
            "{} PR #{}: {}",
            if is_draft { "Draft" } else { "Ready" },
            pr_number,
            pr_url
        ),
    ));

    // ── Step 10-11: Auto-Merge (conditional) ──────────────────────────────

    let mut auto_merged = false;

    let mut merge_sha = String::new();

    if gates_pass {
        match gh.merge_pr(pr_number).await {
            Ok(sha) => {
                merge_sha = sha;
                steps.push(Step::ok("merge", "Squash-merged successfully."));
                auto_merged = true;
            }
            Err(e) => {
                steps.push(Step::fail(
                    "merge",
                    format!("Auto-merge failed: {}. PR left as draft.", e),
                ));
            }
        }
    } else if auto_merge {
        // User wanted auto-merge but gates didn't pass
        let mut reasons = Vec::new();
        if !matches!(ci_status, CIWaitResult::Success(_)) {
            reasons.push("CI not passed");
        }
        if confidence < min_conf {
            reasons.push("confidence below threshold for trust level");
        }
        if review_score < min_review {
            reasons.push("self-review score below threshold for trust level");
        }
        if count_changed_lines(&fix_files) > max_lines {
            reasons.push("too many lines changed");
        }
        if track.trust_level == db::TrustLevel::Rookie {
            reasons.push("trust level too low (need 3+ successful fixes)");
        }
        steps.push(Step::skipped(
            "merge",
            format!("Auto-merge skipped: {}", reasons.join(", ")),
        ));
    }

    // ── Step 12: Post-Merge Monitor (conditional) ─────────────────────────

    if auto_merged {
        use crate::mcp::post_merge_monitor::{PostMergeParams, run as monitor};
        let result = monitor(PostMergeParams {
            project,
            gh: &gh,
            merged_sha: merge_sha.clone(),
            alert_title: alert.title.clone(),
            default_branch: default_branch.clone(),
            memory_id: Some(memory_id.clone()),
            alert_fingerprint: Some(alert_fingerprint.clone()),
            alert_id: Some(alert.id.clone()),
            fix_replay_url: cfg.global.fix_replay_url.clone(),
        }).await;

        use crate::mcp::post_merge_monitor::PostMergeResult;
        match result {
            PostMergeResult::Passed => {
                steps.push(Step::ok("monitor", "10 min post-merge monitoring passed — no regressions."));
            }
            PostMergeResult::Reverted { revert_pr_url } => {
                if let Ok(conn) = db::open() {
                    let _ = db::mark_memory_failed(&conn, &memory_id);
                }
                // Escalate: regression after merge
                let _ = escalation::escalate(&escalation::EscalationContext {
                    alert_title: alert.title.clone(),
                    project: project.name.clone(),
                    reason: "Regression detected after auto-merge — fix reverted".to_string(),
                    diagnosis: Some(diagnosis.clone()),
                    confidence: Some(confidence),
                    attempts: None,
                    max_attempts: None,
                    ci_error: None,
                    pr_url: Some(revert_pr_url.clone()),
                    branch: None,
                }).await;
                steps.push(Step::fail("monitor", format!("Regression detected — auto-reverted: {}", revert_pr_url)));
            }
            PostMergeResult::RevertFailed { error } => {
                if let Ok(conn) = db::open() {
                    let _ = db::mark_memory_failed(&conn, &memory_id);
                }
                steps.push(Step::fail("monitor", format!("Regression detected but revert failed: {}", error)));
            }
        }
    }

    // ── Save incident memory ───────────────────────────────────────────────

    if let Ok(mem_conn) = db::open() {
        let memory = db::IncidentMemory {
            id: memory_id.clone(),
            project: alert.project.clone(),
            alert_title: alert.title.clone(),
            root_cause: diagnosis.clone(),
            fix_summary: fix_explanation.clone(),
            files_fixed: files_changed.clone(),
            fix_worked: true, // CI passed — mark as successful
            confidence: confidence as i64,
            pr_url: Some(pr_url.clone()),
            created_at: Utc::now(),
            fingerprint: Some(alert_fingerprint.clone()),
            postmortem_text: postmortem_text.clone(),
            community_fix_id: None, // set later if fix_replay contribute succeeds
        };
        let _ = db::save_incident_memory(&mem_conn, &memory);
    }

    // ── Fix Replay: contribute pattern to web API ────────────────────────
    if cfg.global.fix_replay {
        if let Some(base_url) = &cfg.global.fix_replay_url {
            let category = if alert.source_integrations.contains(&"sentry".to_string()) {
                "runtime_error"
            } else if alert.source_integrations.contains(&"vercel".to_string()) {
                "build_error"
            } else if alert.source_integrations.contains(&"github".to_string()) {
                "ci_error"
            } else {
                "unknown"
            };
            if let Ok(Some(fix_id)) = contribute_fix_replay(
                &alert_fingerprint,
                &alert.title,
                category,
                &fix_explanation,
                &diagnosis,
                &files_changed,
                confidence,
                base_url,
            ).await {
                // Store community fix ID for future outcome reporting
                if let Ok(conn) = db::open() {
                    let _ = db::set_memory_community_fix_id(&conn, &memory_id, &fix_id);
                }
            }
        }
    }

    // ── Final result ──────────────────────────────────────────────────────

    Ok(serde_json::to_string_pretty(&json!({
        "status": "completed",
        "steps": steps,
        "pr_url": pr_url,
        "pr_number": pr_number,
        "branch": branch_name,
        "confidence": confidence,
        "files_changed": files_changed,
        "auto_merged": auto_merged,
        "error": null
    }))?)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

enum CIWaitResult {
    Success(usize),
    Failure,
    NoChecks,
    Timeout,
}

async fn wait_for_ci(gh: &GitHubClient, commit_sha: &str, max_seconds: u64) -> CIWaitResult {
    let poll_interval = tokio::time::Duration::from_secs(15);
    let start = std::time::Instant::now();
    let max_duration = std::time::Duration::from_secs(max_seconds);

    loop {
        if start.elapsed() > max_duration {
            return CIWaitResult::Timeout;
        }

        match gh.get_check_runs_status(commit_sha).await {
            Ok(status) => match status.status {
                CIStatus::Success => return CIWaitResult::Success(status.details.len()),
                CIStatus::Failure => return CIWaitResult::Failure,
                CIStatus::Pending if start.elapsed() > max_duration => {
                    return CIWaitResult::NoChecks;
                }
                _ => {} // InProgress or Pending — keep waiting
            },
            Err(_) => {
                // API error — keep trying
            }
        }

        tokio::time::sleep(poll_interval).await;
    }
}

fn count_changed_lines(files: &[(String, String)]) -> usize {
    files.iter().map(|(_, content)| content.lines().count()).sum()
}

fn fail_result(steps: &[Step], error: &str) -> String {
    serde_json::to_string_pretty(&json!({
        "status": "failed",
        "steps": steps,
        "confidence": 0,
        "files_changed": [],
        "error": error
    }))
    .unwrap_or_else(|_| format!("{{\"status\":\"failed\",\"error\":\"{}\"}}", error))
}

fn abort_result(steps: &[Step], confidence: u32, diagnosis: &str) -> String {
    serde_json::to_string_pretty(&json!({
        "status": "failed",
        "steps": steps,
        "confidence": confidence,
        "diagnosis": diagnosis,
        "files_changed": [],
        "error": format!("Confidence too low ({}%) to proceed safely. Manual investigation needed.", confidence)
    }))
    .unwrap_or_else(|_| format!("{{\"status\":\"failed\",\"error\":\"Confidence too low\"}}"))
}

// ── Fix Replay helpers ───────────────────────────────────────────────────────

/// Query the web Fix Replay API for community patterns matching this fingerprint.
/// Falls back to text similarity search if no fingerprint match found.
/// Returns parsed MemoryHints if matches found, None otherwise.
async fn query_fix_replay(
    fingerprint: &str,
    alert_title: &str,
    base_url: &str,
) -> anyhow::Result<Option<Vec<MemoryHint>>> {
    // Check local cache first (TTL: 1 hour)
    if let Ok(conn) = db::open() {
        if let Ok(Some(cached)) = db::get_cached_pattern(&conn, fingerprint, 3600) {
            let parsed: Value = serde_json::from_str(&cached)?;
            let hints = parse_fix_replay_response(&parsed);
            if !hints.is_empty() {
                return Ok(Some(hints));
            }
        }
    }

    // Try fingerprint + text similarity (API does hybrid search)
    let encoded_q = urlencoding::encode(alert_title);
    let url = format!(
        "{}/api/patterns/search?fingerprint={}&q={}",
        base_url.trim_end_matches('/'),
        fingerprint,
        encoded_q,
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Ok(None);
    }

    let body: Value = resp.json().await?;

    // Cache the response
    if let Ok(conn) = db::open() {
        let _ = db::cache_pattern(&conn, fingerprint, &body.to_string());
    }

    let hints = parse_fix_replay_response(&body);
    if hints.is_empty() {
        Ok(None)
    } else {
        Ok(Some(hints))
    }
}

fn parse_fix_replay_response(body: &Value) -> Vec<MemoryHint> {
    let matches = match body["matches"].as_array() {
        Some(m) => m,
        None => return vec![],
    };

    let mut hints = Vec::new();
    for m in matches {
        let pattern_text = m["pattern"]["patternText"].as_str().unwrap_or("");
        let fixes = match m["fixes"].as_array() {
            Some(f) => f,
            None => continue,
        };
        for fix in fixes {
            let success = fix["successCount"].as_u64().unwrap_or(0);
            let total = fix["totalApplications"].as_u64().unwrap_or(1).max(1);
            let confidence = ((success as f64 / total as f64) * 100.0) as i64;

            hints.push(MemoryHint {
                alert_title: pattern_text.to_string(),
                root_cause: fix["fixDescription"].as_str().unwrap_or("").to_string(),
                fix_summary: fix["fixApproach"].as_str().unwrap_or("").to_string(),
                files_fixed: fix["filesChangedSummary"]
                    .as_str()
                    .map(|s| s.split(", ").map(String::from).collect())
                    .unwrap_or_default(),
                confidence,
            });
        }
    }
    hints
}

/// Contribute a successful fix pattern to the web Fix Replay API.
/// Returns the community fix_id if the contribution succeeds.
async fn contribute_fix_replay(
    fingerprint: &str,
    alert_title: &str,
    category: &str,
    fix_approach: &str,
    fix_description: &str,
    files_changed: &[String],
    confidence: u32,
    base_url: &str,
) -> anyhow::Result<Option<String>> {
    let url = format!(
        "{}/api/patterns/contribute",
        base_url.trim_end_matches('/')
    );

    let payload = json!({
        "fingerprint": fingerprint,
        "patternText": alert_title,
        "category": category,
        "fixApproach": fix_approach,
        "fixDescription": fix_description,
        "filesChangedSummary": files_changed.join(", "),
        "confidence": confidence,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    let resp = client.post(&url).json(&payload).send().await?;
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let fix_id = body["fixId"].as_str().map(String::from);
    Ok(fix_id)
}
