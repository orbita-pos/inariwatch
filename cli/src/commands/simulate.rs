//! `inariwatch simulate` — Tesla-grade training loop simulator.
//!
//! Features:
//! - Replay real errors from production DB (`--import` + automatic)
//! - Run history with regression detection between runs
//! - `--history` to see improvement over time

use anyhow::Result;
use chrono::{Duration, Utc};
use colored::Colorize;
use rand::Rng;
use std::io::Write;

use crate::db::{self, Alert, BankScenario, IncidentMemory, PendingFeedback, SimRun};
use crate::mcp::fingerprint::compute_error_fingerprint;

// ── Built-in scenarios (fallback when scenario bank is empty) ────────────────

struct BuiltinScenario {
    title: &'static str,
    body: &'static str,
    category: &'static str,
    base_success_rate: f64,
    files: &'static [&'static str],
    fix_approach: &'static str,
}

const BUILTINS: &[BuiltinScenario] = &[
    BuiltinScenario {
        title: "TypeError: Cannot read property 'email' of null",
        body: "at UserProfile.render (src/components/UserProfile.tsx:42:10)",
        category: "runtime_error", base_success_rate: 0.85,
        files: &["src/components/UserProfile.tsx"],
        fix_approach: "Added null check before accessing user.email",
    },
    BuiltinScenario {
        title: "FATAL ERROR: Reached heap limit - JavaScript heap out of memory",
        body: "CALL_AND_RETRY_LAST Allocation failed\nat build step webpack:compile",
        category: "build_error", base_success_rate: 0.60,
        files: &["webpack.config.js", "package.json"],
        fix_approach: "Increased Node memory limit and split vendor chunks",
    },
    BuiltinScenario {
        title: "Error: ECONNREFUSED 127.0.0.1:5432",
        body: "PostgreSQL connection refused during migration\nat DatabasePool.connect",
        category: "infrastructure", base_success_rate: 0.40,
        files: &["src/db/pool.ts", "docker-compose.yml"],
        fix_approach: "Added connection retry with exponential backoff",
    },
    BuiltinScenario {
        title: "SyntaxError: Unexpected token '<' in JSON at position 0",
        body: "at JSON.parse (native)\nat fetchUserData (src/api/users.ts:31)",
        category: "runtime_error", base_success_rate: 0.90,
        files: &["src/api/users.ts"],
        fix_approach: "Added response content-type check before JSON parse",
    },
    BuiltinScenario {
        title: "CI: test suite failed — 3 tests failing",
        body: "FAIL src/__tests__/auth.test.ts\nExpected: 200, Received: 401",
        category: "ci_error", base_success_rate: 0.75,
        files: &["src/__tests__/auth.test.ts", "src/middleware/auth.ts"],
        fix_approach: "Fixed token expiry check in auth middleware",
    },
    BuiltinScenario {
        title: "Error: Rate limit exceeded for API endpoint /api/search",
        body: "429 Too Many Requests\nat RateLimiter.check",
        category: "runtime_error", base_success_rate: 0.70,
        files: &["src/middleware/rate-limit.ts"],
        fix_approach: "Increased rate limit window and added request deduplication",
    },
    BuiltinScenario {
        title: "Vercel deploy failed: Build exceeded 45s timeout",
        body: "Error: Command 'next build' exited with code 1\nModule not found",
        category: "build_error", base_success_rate: 0.80,
        files: &["tsconfig.json", "next.config.js"],
        fix_approach: "Fixed path alias resolution in tsconfig",
    },
    BuiltinScenario {
        title: "Unhandled promise rejection: NetworkError when attempting to fetch",
        body: "at async loadDashboardData\nERR_INTERNET_DISCONNECTED",
        category: "runtime_error", base_success_rate: 0.65,
        files: &["src/pages/Dashboard.tsx", "src/lib/fetch.ts"],
        fix_approach: "Added offline detection and retry queue for failed requests",
    },
    BuiltinScenario {
        title: "Error: ENOMEM - not enough memory for deployment",
        body: "Container killed by OOM killer\nMemory limit: 512MB, Peak: 780MB",
        category: "infrastructure", base_success_rate: 0.50,
        files: &["Dockerfile", "src/workers/processor.ts"],
        fix_approach: "Reduced worker concurrency and added memory-bounded queue",
    },
    BuiltinScenario {
        title: "Stripe webhook signature verification failed",
        body: "No signatures found matching expected signature for payload",
        category: "runtime_error", base_success_rate: 0.85,
        files: &["src/api/webhooks/stripe.ts"],
        fix_approach: "Used raw body buffer instead of parsed JSON for signature verification",
    },
];

// ── Unified scenario type ────────────────────────────────────────────────────

struct Scenario {
    title: String,
    body: String,
    category: String,
    base_success_rate: f64,
    files: Vec<String>,
    fix_approach: String,
    source: String, // "real" or "synthetic"
}

// ── Entry points ─────────────────────────────────────────────────────────────

pub async fn run(cycles: usize, speed: u64) -> Result<()> {
    let conn = db::open_sim()?;
    run_simulation(&conn, cycles, speed).await
}

pub async fn run_import() -> Result<()> {
    let sim_conn = db::open_sim()?;
    let prod_conn = db::open()?;
    import_from_production(&sim_conn, &prod_conn)
}

pub async fn run_history() -> Result<()> {
    let conn = db::open_sim()?;
    show_history(&conn)
}

// ── Import real errors from production ───────────────────────────────────────

fn import_from_production(
    sim_conn: &rusqlite::Connection,
    prod_conn: &rusqlite::Connection,
) -> Result<()> {
    let alerts = db::get_recent_alerts(prod_conn, None, 200)?;

    if alerts.is_empty() {
        println!("  No alerts in production DB. Run {} first.", "inariwatch watch".cyan());
        return Ok(());
    }

    let before = db::count_scenarios(sim_conn);
    let mut imported = 0;

    for alert in &alerts {
        let fp = alert.fingerprint.clone().unwrap_or_else(|| {
            compute_error_fingerprint(&alert.title, &alert.body)
        });

        // Determine category from title
        let category = categorize_alert(&alert.title);

        // Check if we have a successful fix for this alert
        let memories = db::get_relevant_memories(prod_conn, &alert.project, &alert.title, Some(&fp), 1)?;
        let (fix_approach, success_rate) = if let Some(mem) = memories.first() {
            (
                Some(mem.fix_summary.clone()),
                if mem.fix_worked { 0.80 } else { 0.35 },
            )
        } else {
            (None, 0.50)
        };

        let scenario = BankScenario {
            id: format!("real-{}", fp.chars().take(16).collect::<String>()),
            title: alert.title.clone(),
            body: alert.body.chars().take(500).collect(),
            category: category.to_string(),
            fingerprint: fp,
            source: "real".to_string(),
            files: memories.first().map(|m| m.files_fixed.clone()).unwrap_or_default(),
            fix_approach,
            base_success_rate: success_rate,
        };

        db::save_scenario(sim_conn, &scenario)?;
        imported += 1;
    }

    let after = db::count_scenarios(sim_conn);
    let new = after - before;

    println!();
    println!("  {}  Import complete", "✓".green());
    println!("  Scanned {} alerts, added {} new scenarios (total: {})",
        imported, new, after);
    println!();

    Ok(())
}

fn categorize_alert(title: &str) -> &'static str {
    let t = title.to_lowercase();
    if t.contains("build") || t.contains("compile") || t.contains("webpack") || t.contains("deploy") {
        "build_error"
    } else if t.contains("ci") || t.contains("test") {
        "ci_error"
    } else if t.contains("econnrefused") || t.contains("enomem") || t.contains("oom")
        || t.contains("container") || t.contains("docker") {
        "infrastructure"
    } else if t.contains("error") || t.contains("exception") || t.contains("typeerror")
        || t.contains("referenceerror") || t.contains("syntaxerror") {
        "runtime_error"
    } else {
        "unknown"
    }
}

// ── Main simulation ──────────────────────────────────────────────────────────

async fn run_simulation(
    conn: &rusqlite::Connection,
    cycles: usize,
    speed: u64,
) -> Result<()> {
    let project = "simulate";
    let mut rng = rand::thread_rng();
    let delay = std::time::Duration::from_millis(speed);

    // Load scenario pool: real scenarios from bank + builtins as fallback
    let bank = db::get_all_scenarios(conn)?;
    let scenarios = build_scenario_pool(&bank);

    let real_count = scenarios.iter().filter(|s| s.source == "real").count();
    let synth_count = scenarios.iter().filter(|s| s.source == "synthetic").count();

    let run_number = db::get_next_run_number(conn);
    let previous_run = db::get_last_sim_run(conn)?;

    println!();
    println!("  {}  Training Loop Simulator", "▶".truecolor(99, 102, 241));
    println!("  {}", "─".repeat(50).dimmed());
    println!("  Run: #{}  ·  Cycles: {}  ·  Speed: {}ms",
        run_number.to_string().bold(), cycles.to_string().bold(), speed);
    println!("  Scenarios: {} real + {} synthetic = {}",
        real_count.to_string().cyan().bold(),
        synth_count,
        scenarios.len().to_string().bold(),
    );
    if let Some(ref prev) = previous_run {
        println!("  Previous:  Run #{} — {:.0}% success rate",
            prev.run_number, prev.success_rate * 100.0);
    }
    println!();

    let mut stats = SimStats::default();
    let mut confidence_sum: f64 = 0.0;

    for cycle in 1..=cycles {
        let scenario = &scenarios[rng.gen_range(0..scenarios.len())];
        let fp = compute_error_fingerprint(&scenario.title, &scenario.body);

        // Step 1: Alert
        let alert_id = format!("sim-{}-alert-{}", run_number, cycle);
        let alert = Alert {
            id: alert_id.clone(),
            project: project.to_string(),
            severity: "critical".to_string(),
            title: scenario.title.clone(),
            body: scenario.body.clone(),
            source_integrations: vec!["sentry".to_string()],
            is_read: false,
            sent_at: None,
            created_at: Utc::now(),
            fingerprint: Some(fp.clone()),
        };
        db::insert_alert(conn, &alert)?;

        let source_tag = if scenario.source == "real" {
            "REAL".cyan()
        } else {
            "SYN ".dimmed()
        };

        print!(
            "  {} {}  {:>3}/{}  ",
            source_tag,
            format!("[{}]", scenario.category).dimmed(),
            cycle, cycles,
        );

        let title_short: String = scenario.title.chars().take(45).collect();
        print!("{}", title_short);
        let _ = std::io::stdout().flush();
        std::thread::sleep(delay);

        // Step 2: Check memory
        let past_fixes = db::get_relevant_memories(conn, project, &scenario.title, Some(&fp), 3)?;
        let has_prior = !past_fixes.is_empty();
        let prior_conf = past_fixes.first().map(|m| m.confidence).unwrap_or(0);

        let learned_boost = if has_prior && prior_conf > 60 { 0.15 }
            else if has_prior { 0.05 }
            else { 0.0 };

        let effective_rate = (scenario.base_success_rate + learned_boost).min(0.98);
        let fix_worked = rng.gen_bool(effective_rate);

        // Step 3: Memory
        let mem_id = format!("sim-{}-mem-{}", run_number, cycle);
        let initial_conf = if has_prior { (prior_conf + 5).min(100) }
            else { rng.gen_range(40..80) };

        let mem = IncidentMemory {
            id: mem_id.clone(),
            project: project.to_string(),
            alert_title: scenario.title.clone(),
            root_cause: format!("{} in {}", scenario.category, scenario.files.join(", ")),
            fix_summary: scenario.fix_approach.clone(),
            files_fixed: scenario.files.clone(),
            fix_worked,
            confidence: initial_conf,
            pr_url: Some(format!("https://github.com/sim/repo/pull/{}", cycle)),
            created_at: Utc::now(),
            fingerprint: Some(fp.clone()),
            postmortem_text: None,
            community_fix_id: None,
        };
        db::save_incident_memory(conn, &mem)?;

        // Step 4: Feedback
        let fb = PendingFeedback {
            id: format!("sim-{}-fb-{}", run_number, cycle),
            memory_id: mem_id.clone(),
            project: project.to_string(),
            alert_title: scenario.title.clone(),
            pr_url: None,
            fix_summary: scenario.fix_approach.clone(),
            created_at: Utc::now(),
            answered: false,
            answer: None,
        };
        db::save_pending_feedback(conn, &fb)?;

        // Step 5: Outcome
        let final_conf;
        if fix_worked {
            db::update_memory_confidence(conn, &mem_id, 5)?;
            db::answer_feedback(conn, &fb.id, true)?;
            stats.succeeded += 1;
            final_conf = (initial_conf + 5).min(100);

            println!("  {} {}  conf: {}→{}",
                "✓".green(),
                if has_prior { "(learned)" } else { "" }.cyan(),
                initial_conf, final_conf,
            );
        } else {
            let recur = Alert {
                id: format!("sim-{}-recur-{}", run_number, cycle),
                project: project.to_string(),
                severity: "critical".to_string(),
                title: scenario.title.clone(),
                body: scenario.body.clone(),
                source_integrations: vec!["sentry".to_string()],
                is_read: false,
                sent_at: None,
                created_at: Utc::now(),
                fingerprint: Some(fp.clone()),
            };
            db::insert_alert(conn, &recur)?;

            let since = Utc::now() - Duration::hours(1);
            let _ = db::has_alert_with_fingerprint_since(conn, &fp, since, &alert_id)?;
            db::mark_memory_failed(conn, &mem_id)?;
            db::update_memory_confidence(conn, &mem_id, -20)?;
            db::answer_feedback(conn, &fb.id, false)?;
            stats.failed += 1;
            final_conf = (initial_conf - 20).max(0);

            println!("  {} {}  conf: {}→{}",
                "✗".red(),
                if has_prior { "(known fail)" } else { "" }.red(),
                initial_conf, final_conf,
            );
        }

        if has_prior { stats.learned += 1; }
        stats.total += 1;
        confidence_sum += final_conf as f64;

        std::thread::sleep(delay);
    }

    // ── Save run ─────────────────────────────────────────────────────────────
    let rate = if stats.total > 0 { stats.succeeded as f64 / stats.total as f64 } else { 0.0 };
    let avg_conf = if stats.total > 0 { confidence_sum / stats.total as f64 } else { 0.0 };
    let rec = db::get_track_record(conn, project)?;

    let sim_run = SimRun {
        id: uuid::Uuid::new_v4().to_string(),
        run_number,
        cycles: cycles as i64,
        total: stats.total as i64,
        succeeded: stats.succeeded as i64,
        failed: stats.failed as i64,
        success_rate: rate,
        learned_count: stats.learned as i64,
        avg_confidence: avg_conf,
        trust_level: rec.trust_level.name().to_string(),
        created_at: Utc::now(),
    };
    db::save_sim_run(conn, &sim_run)?;

    // ── Report ───────────────────────────────────────────────────────────────
    println!();
    println!("  {}", "═".repeat(50).dimmed());
    println!("  {}  Run #{} Complete", "★".yellow(), run_number);
    println!("  {}", "─".repeat(50).dimmed());
    println!();

    println!("  {:<24} {}", "Total fixes".dimmed(), stats.total.to_string().bold());
    println!("  {:<24} {} ({:.0}%)", "Successful".dimmed(),
        stats.succeeded.to_string().green().bold(), rate * 100.0);
    println!("  {:<24} {}", "Failed".dimmed(),
        if stats.failed > 0 { stats.failed.to_string().red().bold() } else { "0".normal() });
    println!("  {:<24} {}", "Learned from past".dimmed(),
        stats.learned.to_string().cyan().bold());
    println!("  {:<24} {:.0}%", "Avg confidence".dimmed(), avg_conf);

    let (level_color, level_name) = match rec.trust_level {
        db::TrustLevel::Rookie     => ("⬤".red(),    "Rookie"),
        db::TrustLevel::Apprentice => ("⬤".yellow(), "Apprentice"),
        db::TrustLevel::Trusted    => ("⬤".cyan(),   "Trusted"),
        db::TrustLevel::Expert     => ("⬤".green(),  "Expert"),
    };
    println!();
    println!("  {:<24} {} {}", "Trust level".dimmed(), level_color, level_name.bold());

    // ── Regression check ─────────────────────────────────────────────────────
    if let Some(prev) = previous_run {
        println!();
        println!("  {}", "─ vs previous run ─".dimmed());

        let rate_delta = (rate - prev.success_rate) * 100.0;
        let conf_delta = avg_conf - prev.avg_confidence;
        let learned_delta = stats.learned as i64 - prev.learned_count;

        print_delta("Success rate", rate_delta, "%");
        print_delta("Avg confidence", conf_delta, "pts");
        print_delta_i("Learned fixes", learned_delta);

        if rate_delta < -5.0 {
            println!();
            println!("  {}  REGRESSION: success rate dropped {:.1}% since last run",
                "⚠".red().bold(), rate_delta.abs());
        } else if rate_delta > 5.0 {
            println!();
            println!("  {}  IMPROVEMENT: success rate up {:.1}% since last run",
                "↑".green().bold(), rate_delta);
        }
    }

    if stats.learned > 0 {
        println!();
        println!("  {}  System reused knowledge {} times.",
            "↻".cyan(), stats.learned.to_string().cyan().bold());
    }

    println!();
    Ok(())
}

fn print_delta(label: &str, delta: f64, unit: &str) {
    let (arrow, color_str) = if delta > 0.5 {
        ("↑", format!("+{:.1}{}", delta, unit).to_string())
    } else if delta < -0.5 {
        ("↓", format!("{:.1}{}", delta, unit).to_string())
    } else {
        ("=", format!("~0{}", unit).to_string())
    };

    let colored = if delta > 0.5 { color_str.green() }
        else if delta < -0.5 { color_str.red() }
        else { color_str.dimmed() };

    println!("  {:<24} {} {}", label.dimmed(), arrow, colored);
}

fn print_delta_i(label: &str, delta: i64) {
    let (arrow, val) = if delta > 0 {
        ("↑", format!("+{}", delta))
    } else if delta < 0 {
        ("↓", format!("{}", delta))
    } else {
        ("=", "~0".to_string())
    };

    let colored = if delta > 0 { val.green() }
        else if delta < 0 { val.red() }
        else { val.dimmed() };

    println!("  {:<24} {} {}", label.dimmed(), arrow, colored);
}

// ── History ──────────────────────────────────────────────────────────────────

fn show_history(conn: &rusqlite::Connection) -> Result<()> {
    let runs = db::get_sim_runs(conn, 20)?;

    if runs.is_empty() {
        println!("\n  No simulation runs yet. Run {} first.\n", "inariwatch simulate".cyan());
        return Ok(());
    }

    let scenarios = db::count_scenarios(conn);

    println!();
    println!("  {}  Simulation History", "◆".truecolor(99, 102, 241));
    println!("  {}", "─".repeat(50).dimmed());
    println!("  Scenario bank: {} ({} real)",
        scenarios.to_string().bold(),
        db::get_all_scenarios(conn)?.iter().filter(|s| s.source == "real").count(),
    );
    println!();

    // Header
    println!("  {:<5} {:<8} {:<10} {:<10} {:<10} {:<10} {}",
        "Run".dimmed(), "Cycles".dimmed(), "Success".dimmed(),
        "Rate".dimmed(), "Learned".dimmed(), "Conf".dimmed(), "Trust".dimmed());
    println!("  {}", "─".repeat(65).dimmed());

    // Runs (reversed so oldest first)
    let mut runs_asc = runs.clone();
    runs_asc.reverse();

    let mut prev_rate: Option<f64> = None;
    for r in &runs_asc {
        let rate_pct = r.success_rate * 100.0;
        let rate_str = format!("{:.0}%", rate_pct);
        let rate_colored = if rate_pct >= 85.0 { rate_str.green() }
            else if rate_pct >= 60.0 { rate_str.yellow() }
            else { rate_str.red() };

        let trend = if let Some(pr) = prev_rate {
            let d = (r.success_rate - pr) * 100.0;
            if d > 2.0 { "↑".green() }
            else if d < -2.0 { "↓".red() }
            else { "=".dimmed() }
        } else {
            " ".normal()
        };

        println!("  #{:<4} {:<8} {:<10} {} {:<7} {:<10} {:<10} {}",
            r.run_number,
            r.cycles,
            format!("{}/{}", r.succeeded, r.total),
            trend,
            rate_colored,
            r.learned_count,
            format!("{:.0}%", r.avg_confidence),
            r.trust_level.bold(),
        );

        prev_rate = Some(r.success_rate);
    }

    // Summary trend
    if runs_asc.len() >= 2 {
        let first = &runs_asc[0];
        let last = &runs_asc[runs_asc.len() - 1];
        let overall_delta = (last.success_rate - first.success_rate) * 100.0;

        println!("  {}", "─".repeat(65).dimmed());
        if overall_delta > 2.0 {
            println!("  {}  Overall trend: +{:.1}% improvement across {} runs",
                "↑".green().bold(), overall_delta, runs_asc.len());
        } else if overall_delta < -2.0 {
            println!("  {}  Overall trend: {:.1}% regression across {} runs",
                "↓".red().bold(), overall_delta, runs_asc.len());
        } else {
            println!("  {}  Overall trend: stable across {} runs",
                "=".dimmed(), runs_asc.len());
        }
    }

    println!();
    Ok(())
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn build_scenario_pool(bank: &[BankScenario]) -> Vec<Scenario> {
    let mut pool: Vec<Scenario> = Vec::new();

    // Add real scenarios from bank
    for s in bank {
        pool.push(Scenario {
            title: s.title.clone(),
            body: s.body.clone(),
            category: s.category.clone(),
            base_success_rate: s.base_success_rate,
            files: s.files.clone(),
            fix_approach: s.fix_approach.clone().unwrap_or_else(|| "AI-generated fix".to_string()),
            source: s.source.clone(),
        });
    }

    // Always add builtins for variety
    for b in BUILTINS {
        pool.push(Scenario {
            title: b.title.to_string(),
            body: b.body.to_string(),
            category: b.category.to_string(),
            base_success_rate: b.base_success_rate,
            files: b.files.iter().map(|f| f.to_string()).collect(),
            fix_approach: b.fix_approach.to_string(),
            source: "synthetic".to_string(),
        });
    }

    pool
}

#[derive(Default)]
struct SimStats {
    total: usize,
    succeeded: usize,
    failed: usize,
    learned: usize,
}
