# Post-Merge Monitoring

After an auto-merged fix, InariWatch watches for regressions for 10 minutes using phased canary monitoring. If the fix caused a new problem, it's automatically reverted.

## Canary Phases

The monitoring intensity decreases over time. Early regressions (more likely to be caused by the fix) get faster response. Late anomalies (more likely to be noise) get lighter treatment.

| Phase | Window | Check Interval | On Regression |
|-------|--------|---------------|---------------|
| **canary_fast** | 0–3 min | Every 30s | Revert immediately |
| **canary_normal** | 3–7 min | Every 60s | Revert + alert on-call |
| **canary_slow** | 7–10 min | Every 2 min | Alert only (no auto-revert) |

**Why phased?** In the first 3 minutes, few users are affected — fast revert minimizes blast radius. By minute 7, the fix has been live long enough that a new error is more likely coincidence than regression.

## What It Monitors

Each check evaluates three signals:

1. **Sentry** — Queries for new issues matching the original error. If a new issue appears or an existing issue is flagged as a regression, it triggers.

2. **Uptime** — Hits your configured uptime monitors. A 500 error or unreachable response means the site is down.

3. **Fingerprint** — Checks if a new alert with the same error fingerprint was ingested since the merge. This catches errors arriving via `@inariwatch/capture` or any other webhook source.

## Auto-Revert

When a regression is detected (and the current phase allows auto-revert):

1. The bot creates a revert branch (`revert-{sha}`)
2. Opens a revert PR with the regression details
3. Attempts to merge the revert immediately
4. Updates the remediation session to `reverted` status
5. Creates a new alert about the revert
6. Escalates to on-call if configured

The original fix is recorded as a failed fix for anti-pattern learning. The revert counts against the project's success rate for trust level calculation.

## After 10 Minutes

If no regression is detected:
- Session status → `completed`
- Monitoring status → `passed`
- Community fix success count incremented
- Status page incident resolved
- Confidence calibration point recorded (predicted vs actual outcome)

## What If the Revert Fails?

If the revert PR can't be merged (conflict, branch protection), the bot logs a warning and escalates to on-call. The session is marked `reverted` with the revert PR URL so you can merge it manually.

## Configuration

Post-merge monitoring activates automatically when a fix is auto-merged. To disable it, set `postMergeMonitor: false` in your project's auto-merge config. Phase durations and intervals are not currently configurable.
