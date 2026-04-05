# How It Works

InariWatch monitors your app for errors and fixes them autonomously. When something breaks, the bot reads your code, writes a fix, verifies it, and opens a PR — without waking you up.

## The Pipeline

### 1. Error Detected

An error arrives from any connected source: Sentry, Vercel, GitHub, Datadog, Expo, or your own app via `@inariwatch/capture`. InariWatch creates an alert and runs a free AI analysis immediately.

If `autoRemediate` is enabled and the alert is critical, the pipeline starts automatically.

### 2. Concurrency Check

Before starting, the bot checks if there are too many active remediations (max 3 per project, 10 global). If the limit is reached, the session is queued and retried when a slot opens.

### 3. Context Gathering

The bot pulls context from every connected integration in parallel:

- **Sentry** — stack traces, breadcrumbs, event tags
- **Vercel** — build logs from the failed deployment
- **GitHub** — CI check logs, recent commits
- **Datadog** — performance metrics for the affected service
- **Substrate** — the exact I/O recording of what happened
- **Code Intelligence** — relevant code patterns from your indexed repo

If a service is down or not configured, the bot continues without it.

### 4. Incident Correlation

Before diagnosing, the bot checks if other remediations are already running for the same project. If multiple errors stem from the same root cause (same files affected, or errors within a 5-minute window), they're grouped into an incident.

The first session becomes the **leader**. Others wait up to 5 minutes for the leader to finish. If the leader's fix resolves the root cause, follower sessions close automatically — one PR instead of five. See [Incident Correlation](incident-correlation.md).

### 5. AI Diagnosis

The bot sends the error + all gathered context to your AI provider. It returns:
- What went wrong (root cause)
- Which files to read (1-5 files)
- Confidence score (0-100)

The raw confidence is **calibrated** against the project's historical accuracy. If the AI consistently overestimates its confidence, the score is adjusted down. See [Learning](learning.md).

If calibrated confidence is below 30%, the bot stops and escalates to your on-call.

### 6. File Locking

The bot acquires locks on the files it needs to modify. If another remediation already holds a lock on the same file, the bot waits up to 30 seconds. If all files are locked, it fails gracefully with `concurrent_conflict`. Locks expire after 10 minutes.

### 7. Code Fix

The bot reads the identified files, then asks the AI to generate a fix. Before generating, it checks for **anti-patterns** — past failed fixes for similar errors. If found, it injects "don't repeat these approaches" into the prompt. See [Learning](learning.md).

If this is a retry after a CI failure, the previous attempt's error logs are included so the AI tries a different approach.

### 8. Security Scan

Before anything is pushed, the fix runs through a 3-layer security scan:
1. **17 ESLint rules** — eval, innerHTML, child_process, SQL injection patterns
2. **20 regex patterns** — hardcoded secrets, SSRF, prototype pollution, XSS, open redirects
3. **AI security review** — a separate AI call focused on security vulnerabilities

HIGH findings are flagged. The fix still proceeds as a draft PR, but the auto-merge gate will block it.

### 9. Self-Review

The AI reviews its own fix — comparing original files vs modified files. It scores the fix 0-100 and recommends `approve`, `flag`, or `reject`. If the AI call fails, the score defaults to 0 (reject).

### 10. Push + CI

The bot creates a branch (`radar/fix-{id}-{timestamp}`), commits the files, and pushes. Then it polls CI checks every 15 seconds for up to 5 minutes.

If CI fails, the bot retries with the CI error logs (up to 3 attempts total). If all attempts fail, the failure is recorded for anti-pattern learning.

### 11. Staging Verification

If a staging server is configured, the bot deploys the fix branch to an ephemeral Docker container. A Playwright browser bot then:
- Replays the original user session (HTTP requests + UI interactions)
- Takes screenshots at every step
- Checks response bodies against the original recording
- Runs AI visual analysis on the final screenshot (before/after comparison)

If staging isn't configured, this step is skipped.

### 12. Auto-Merge Gates

11 independent safety gates are evaluated. Every gate must pass for auto-merge. If any gate fails, a draft PR is created instead. See [Auto-Merge Gates](auto-merge-gates.md).

### 13. PR Created

- **All gates pass** → PR is auto-merged, post-merge monitoring starts
- **Any gate fails** → Draft PR created for human review

The PR body includes which context sources were available (e.g., `sentry: ✓, datadog: ✗`) so the reviewer knows what info the bot had.

### 14. Post-Merge Monitoring

For 10 minutes after merge, the bot watches for regressions using 3 canary phases — aggressive checking in the first 3 minutes, relaxing over time. If a regression is detected, it automatically creates and merges a revert PR. See [Post-Merge Monitoring](post-merge-monitor.md).

### 15. Done

The alert is marked resolved. The AI's confidence prediction is recorded against the actual outcome for calibration. If the fix was auto-merged and monitoring passed, the project's trust level increases. If the fix failed, the failure is recorded for future learning.
