# Incident Correlation

When a broken deploy triggers 5 different errors, InariWatch detects they're related and fixes them as one incident — not five separate PRs.

## How It Works

Before diagnosing, the bot checks for other active remediation sessions on the same project. If it finds related sessions, it groups them into an **incident**.

### Detection Heuristics

Two sessions are correlated if either condition is met:
- **File overlap** — more than 50% of the diagnosed files are shared between sessions
- **Time proximity** — 2+ sessions started within a 5-minute window

### Leader / Follower

The first session to start becomes the **leader**. All subsequent sessions become **followers**.

- **Leader** proceeds normally through the full pipeline
- **Followers** wait up to 5 minutes (polling every 30s) for the leader to finish
- If the leader **succeeds** → followers close as `resolved_by_incident_leader`
- If the leader **fails** or times out → followers proceed independently

### What You See

- Events: `incident_follower` with the incident ID and leader session
- Step: "Part of incident with N related errors — waiting for leader fix..."
- Completed sessions show: "Resolved by incident leader (session abc12345)"

## Why This Matters

Without correlation:
- 1 broken deploy → 5 errors → 5 remediations → 5 branches → 5 PRs → potential merge conflicts

With correlation:
- 1 broken deploy → 5 errors → 1 leader fix → 4 auto-resolved → 1 clean PR

## Limits

| Parameter | Value |
|-----------|-------|
| Correlation window | 30 minutes |
| Time proximity threshold | 5 minutes |
| File overlap threshold | 50% |
| Leader wait timeout | 5 minutes |
| Poll interval | 30 seconds |

If correlation detection fails (DB error, etc.), the session proceeds normally. The feature is non-blocking.
