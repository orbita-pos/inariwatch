use serde_json::{json, Value};

use crate::ai;
use crate::ai::prompts::RemediationContext;
use crate::config;
use crate::db;
use crate::integrations::github::{CIStatus, GitHubClient};
use crate::integrations::sentry::SentryClient;
use crate::integrations::vercel::VercelClient;
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
        "Project: {}, GitHub: {}, AI: configured",
        project.name, gh_config.repo
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
                        if let Ok(Some(trace)) = client.get_issue_latest_event(&issue.id).await {
                            return Some(trace);
                        }
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
    context.sentry_stack_trace = sentry_result;
    context.vercel_build_logs = vercel_result;
    context.github_ci_logs = github_result;

    let model = Some(cfg.global.ai_model.as_str());
    let diagnosis_result = ai::diagnose(
        ai_key,
        model,
        &alert.title,
        &alert.body,
        &alert.source_integrations,
        &repo_files,
        &context,
        alert.body.lines().next(), // Use first line as previous reasoning hint
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

    // Evaluate auto-merge gates
    let gates_pass = auto_merge
        && matches!(ci_status, CIWaitResult::Success(_))
        && confidence >= safety::CONFIDENCE_DRAFT_ONLY
        && review_score >= safety::MIN_SELF_REVIEW_SCORE
        && review_recommendation != "reject"
        && count_changed_lines(&fix_files) <= safety::MAX_LINES_FOR_AUTO_MERGE;

    let is_draft = !gates_pass;

    let pr_body = format!(
        "## InariWatch AI Fix\n\n\
         **Alert:** {}\n\
         **Diagnosis:** {}\n\
         **Confidence:** {}%\n\
         **Self-review:** {}/100 ({})\n\
         **Files changed:** {}\n\n\
         ### What changed\n{}\n\n\
         ---\n*Automated by InariWatch*",
        alert.title,
        diagnosis,
        confidence,
        review_score,
        review_recommendation,
        files_changed.join(", "),
        fix_explanation,
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

    if gates_pass {
        match gh.merge_pr(pr_number).await {
            Ok(_merge_sha) => {
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
        if confidence < safety::CONFIDENCE_DRAFT_ONLY {
            reasons.push("confidence below 70%");
        }
        if review_score < safety::MIN_SELF_REVIEW_SCORE {
            reasons.push("self-review score below 70");
        }
        if count_changed_lines(&fix_files) > safety::MAX_LINES_FOR_AUTO_MERGE {
            reasons.push("too many lines changed");
        }
        steps.push(Step::skipped(
            "merge",
            format!("Auto-merge skipped: {}", reasons.join(", ")),
        ));
    }

    // ── Step 12: Post-Merge Monitor (conditional) ─────────────────────────

    if auto_merged {
        steps.push(Step::ok(
            "monitor",
            "Post-merge monitoring skipped in CLI v2 (available in web). Monitor manually.",
        ));
        // Note: Full post-merge monitoring (10-min poll + auto-revert) is complex
        // and better suited for the web's long-running process. The CLI tool returns
        // immediately after merge so the AI agent can continue working.
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
