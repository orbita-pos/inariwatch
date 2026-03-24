//! `inariwatch simulate` — Run a simulated training loop.
//!
//! Generates realistic error scenarios, simulates fixes with varying success rates,
//! and shows how the system learns over time. No external services needed.

use anyhow::Result;
use chrono::{Duration, Utc};
use colored::Colorize;
use rand::Rng;
use std::io::Write;

use crate::db::{self, Alert, IncidentMemory, PendingFeedback};
use crate::mcp::fingerprint::compute_error_fingerprint;

// ── Realistic error scenarios ────────────────────────────────────────────────

struct ErrorScenario {
    title: &'static str,
    body: &'static str,
    category: &'static str,
    /// Base probability the fix works (0.0–1.0). System learns to improve this.
    base_success_rate: f64,
    files: &'static [&'static str],
    fix_approach: &'static str,
}

const SCENARIOS: &[ErrorScenario] = &[
    ErrorScenario {
        title: "TypeError: Cannot read property 'email' of null",
        body: "at UserProfile.render (src/components/UserProfile.tsx:42:10)",
        category: "runtime_error",
        base_success_rate: 0.85,
        files: &["src/components/UserProfile.tsx"],
        fix_approach: "Added null check before accessing user.email",
    },
    ErrorScenario {
        title: "FATAL ERROR: Reached heap limit - JavaScript heap out of memory",
        body: "CALL_AND_RETRY_LAST Allocation failed - process out of memory\nat build step webpack:compile",
        category: "build_error",
        base_success_rate: 0.60,
        files: &["webpack.config.js", "package.json"],
        fix_approach: "Increased Node memory limit and split vendor chunks",
    },
    ErrorScenario {
        title: "Error: ECONNREFUSED 127.0.0.1:5432",
        body: "PostgreSQL connection refused during migration\nat DatabasePool.connect (src/db/pool.ts:18)",
        category: "infrastructure",
        base_success_rate: 0.40,
        files: &["src/db/pool.ts", "docker-compose.yml"],
        fix_approach: "Added connection retry with exponential backoff",
    },
    ErrorScenario {
        title: "SyntaxError: Unexpected token '<' in JSON at position 0",
        body: "at JSON.parse (native)\nat fetchUserData (src/api/users.ts:31)",
        category: "runtime_error",
        base_success_rate: 0.90,
        files: &["src/api/users.ts"],
        fix_approach: "Added response content-type check before JSON parse",
    },
    ErrorScenario {
        title: "CI: test suite failed — 3 tests failing",
        body: "FAIL src/__tests__/auth.test.ts\nExpected: 200, Received: 401\nTest: should authenticate valid user",
        category: "ci_error",
        base_success_rate: 0.75,
        files: &["src/__tests__/auth.test.ts", "src/middleware/auth.ts"],
        fix_approach: "Fixed token expiry check in auth middleware",
    },
    ErrorScenario {
        title: "Error: Rate limit exceeded for API endpoint /api/search",
        body: "429 Too Many Requests\nat RateLimiter.check (src/middleware/rate-limit.ts:22)",
        category: "runtime_error",
        base_success_rate: 0.70,
        files: &["src/middleware/rate-limit.ts"],
        fix_approach: "Increased rate limit window and added request deduplication",
    },
    ErrorScenario {
        title: "Vercel deploy failed: Build exceeded 45s timeout",
        body: "Error: Command 'next build' exited with code 1\nModule not found: Can't resolve '@/lib/utils'",
        category: "build_error",
        base_success_rate: 0.80,
        files: &["tsconfig.json", "next.config.js"],
        fix_approach: "Fixed path alias resolution in tsconfig",
    },
    ErrorScenario {
        title: "Unhandled promise rejection: NetworkError when attempting to fetch",
        body: "at async loadDashboardData (src/pages/Dashboard.tsx:55)\nERR_INTERNET_DISCONNECTED",
        category: "runtime_error",
        base_success_rate: 0.65,
        files: &["src/pages/Dashboard.tsx", "src/lib/fetch.ts"],
        fix_approach: "Added offline detection and retry queue for failed requests",
    },
    ErrorScenario {
        title: "Error: ENOMEM - not enough memory for deployment",
        body: "Container killed by OOM killer\nMemory limit: 512MB, Peak: 780MB",
        category: "infrastructure",
        base_success_rate: 0.50,
        files: &["Dockerfile", "src/workers/processor.ts"],
        fix_approach: "Reduced worker concurrency and added memory-bounded queue",
    },
    ErrorScenario {
        title: "Stripe webhook signature verification failed",
        body: "Error: No signatures found matching expected signature for payload\nat verifySignature (src/api/webhooks/stripe.ts:15)",
        category: "runtime_error",
        base_success_rate: 0.85,
        files: &["src/api/webhooks/stripe.ts"],
        fix_approach: "Used raw body buffer instead of parsed JSON for signature verification",
    },
];

// ── Simulation engine ────────────────────────────────────────────────────────

pub async fn run(cycles: usize, speed: u64) -> Result<()> {
    let conn = db::open()?;
    let project = "simulate";
    let mut rng = rand::thread_rng();

    let delay = std::time::Duration::from_millis(speed);

    println!();
    println!("  {}  Training Loop Simulator", "▶".truecolor(99, 102, 241));
    println!("  {}", "─".repeat(44).dimmed());
    println!("  Cycles: {}  ·  Speed: {}ms", cycles.to_string().bold(), speed);
    println!();

    let mut stats = SimStats::default();

    for cycle in 1..=cycles {
        // Pick a random scenario
        let scenario = &SCENARIOS[rng.gen_range(0..SCENARIOS.len())];
        let fp = compute_error_fingerprint(scenario.title, scenario.body);

        // ── Step 1: Alert arrives ────────────────────────────────────────
        let alert_id = format!("sim-alert-{}", cycle);
        let alert = Alert {
            id: alert_id.clone(),
            project: project.to_string(),
            severity: "critical".to_string(),
            title: scenario.title.to_string(),
            body: scenario.body.to_string(),
            source_integrations: vec!["sentry".to_string()],
            is_read: false,
            sent_at: None,
            created_at: Utc::now(),
            fingerprint: Some(fp.clone()),
        };
        db::insert_alert(&conn, &alert)?;

        print!(
            "  {}  {:>3}/{}  ",
            format!("[{}]", scenario.category).dimmed(),
            cycle,
            cycles,
        );

        let title_short: String = scenario.title.chars().take(50).collect();
        print!("{}", title_short);
        let _ = std::io::stdout().flush();
        std::thread::sleep(delay);

        // ── Step 2: Check if we've seen this before ──────────────────────
        let past_fixes = db::get_relevant_memories(&conn, project, scenario.title, Some(&fp), 3)?;
        let has_prior_knowledge = !past_fixes.is_empty();
        let prior_confidence = past_fixes.first().map(|m| m.confidence).unwrap_or(0);

        // Learning boost: if we've seen this error succeed before, higher chance
        let learned_boost = if has_prior_knowledge && prior_confidence > 60 {
            0.15
        } else if has_prior_knowledge {
            0.05
        } else {
            0.0
        };

        let effective_rate = (scenario.base_success_rate + learned_boost).min(0.98);
        let fix_worked = rng.gen_bool(effective_rate);

        // ── Step 3: Save incident memory ─────────────────────────────────
        let mem_id = format!("sim-mem-{}", cycle);
        let initial_confidence = if has_prior_knowledge {
            // Learned from past — start higher
            (prior_confidence + 5).min(100)
        } else {
            rng.gen_range(40..80)
        };

        let mem = IncidentMemory {
            id: mem_id.clone(),
            project: project.to_string(),
            alert_title: scenario.title.to_string(),
            root_cause: format!("{} in {}", scenario.category, scenario.files.join(", ")),
            fix_summary: scenario.fix_approach.to_string(),
            files_fixed: scenario.files.iter().map(|f| f.to_string()).collect(),
            fix_worked,
            confidence: initial_confidence,
            pr_url: Some(format!("https://github.com/sim/repo/pull/{}", cycle)),
            created_at: Utc::now(),
            fingerprint: Some(fp.clone()),
            postmortem_text: None,
            community_fix_id: None,
        };
        db::save_incident_memory(&conn, &mem)?;

        // ── Step 4: Queue feedback ───────────────────────────────────────
        let fb = PendingFeedback {
            id: format!("sim-fb-{}", cycle),
            memory_id: mem_id.clone(),
            project: project.to_string(),
            alert_title: scenario.title.to_string(),
            pr_url: Some(format!("https://github.com/sim/repo/pull/{}", cycle)),
            fix_summary: scenario.fix_approach.to_string(),
            created_at: Utc::now(),
            answered: false,
            answer: None,
        };
        db::save_pending_feedback(&conn, &fb)?;

        // ── Step 5: Simulate 30-min monitor outcome ──────────────────────
        if fix_worked {
            // No recurrence — boost confidence
            db::update_memory_confidence(&conn, &mem_id, 5)?;
            stats.succeeded += 1;

            // Auto-answer feedback as positive
            db::answer_feedback(&conn, &format!("sim-fb-{}", cycle), true)?;

            println!(
                "  {} {}  conf: {}→{}",
                "✓".green(),
                if has_prior_knowledge { "(learned)" } else { "" }.cyan(),
                initial_confidence,
                (initial_confidence + 5).min(100),
            );
        } else {
            // Recurrence — simulate the same alert appearing again
            let recur_alert = Alert {
                id: format!("sim-recur-{}", cycle),
                project: project.to_string(),
                severity: "critical".to_string(),
                title: scenario.title.to_string(),
                body: scenario.body.to_string(),
                source_integrations: vec!["sentry".to_string()],
                is_read: false,
                sent_at: None,
                created_at: Utc::now(),
                fingerprint: Some(fp.clone()),
            };
            db::insert_alert(&conn, &recur_alert)?;

            // Detect recurrence
            let since = Utc::now() - Duration::hours(1);
            let _recurred = db::has_alert_with_fingerprint_since(&conn, &fp, since, &alert_id)?;

            // Mark failed, decrease confidence
            db::mark_memory_failed(&conn, &mem_id)?;
            db::update_memory_confidence(&conn, &mem_id, -20)?;
            stats.failed += 1;

            // Auto-answer feedback as negative
            db::answer_feedback(&conn, &format!("sim-fb-{}", cycle), false)?;

            println!(
                "  {} {}  conf: {}→{}",
                "✗".red(),
                if has_prior_knowledge { "(known fail)" } else { "" }.red(),
                initial_confidence,
                (initial_confidence - 20).max(0),
            );
        }

        if has_prior_knowledge {
            stats.learned_fixes += 1;
        }
        stats.total += 1;

        std::thread::sleep(delay);
    }

    // ── Final report ─────────────────────────────────────────────────────────
    println!();
    println!("  {}", "═".repeat(44).dimmed());
    println!("  {}  Simulation Complete", "★".yellow());
    println!("  {}", "─".repeat(44).dimmed());
    println!();

    let rate = if stats.total > 0 {
        (stats.succeeded as f64 / stats.total as f64) * 100.0
    } else {
        0.0
    };

    println!(
        "  {:<24} {}",
        "Total fixes".dimmed(),
        stats.total.to_string().bold()
    );
    println!(
        "  {:<24} {} ({:.0}%)",
        "Successful".dimmed(),
        stats.succeeded.to_string().green().bold(),
        rate,
    );
    println!(
        "  {:<24} {}",
        "Failed".dimmed(),
        if stats.failed > 0 {
            stats.failed.to_string().red().bold()
        } else {
            "0".normal()
        }
    );
    println!(
        "  {:<24} {}",
        "Learned from past".dimmed(),
        stats.learned_fixes.to_string().cyan().bold(),
    );

    // Show trust level
    let rec = db::get_track_record(&conn, project)?;
    let (level_color, level_name) = match rec.trust_level {
        db::TrustLevel::Rookie     => ("⬤".red(),    "Rookie"),
        db::TrustLevel::Apprentice => ("⬤".yellow(), "Apprentice"),
        db::TrustLevel::Trusted    => ("⬤".cyan(),   "Trusted"),
        db::TrustLevel::Expert     => ("⬤".green(),  "Expert"),
    };

    println!();
    println!(
        "  {:<24} {} {}",
        "Trust level".dimmed(),
        level_color,
        level_name.bold(),
    );

    // Show how learning improved results
    if stats.learned_fixes > 0 {
        println!();
        println!(
            "  {}  The system reused knowledge from past fixes {} times.",
            "↻".cyan(),
            stats.learned_fixes.to_string().cyan().bold(),
        );
        println!(
            "  {}  Each known pattern got a confidence boost, improving future fix quality.",
            " ".normal(),
        );
    }

    // Pending feedback (should be 0 since we auto-answered)
    let pending = db::count_pending_feedback(&conn);
    if pending > 0 {
        println!(
            "\n  {} pending feedback — run {}",
            pending.to_string().yellow().bold(),
            "inariwatch feedback".cyan(),
        );
    }

    println!();
    Ok(())
}

#[derive(Default)]
struct SimStats {
    total: usize,
    succeeded: usize,
    failed: usize,
    learned_fixes: usize,
}
