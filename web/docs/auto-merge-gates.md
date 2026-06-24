# Auto-Merge Gates

Every AI-generated fix is evaluated against 11 independent safety gates. All must pass for auto-merge. If any gate fails, a draft PR is created for human review.

## The 11 Gates

| # | Gate | What it checks | Threshold | Configurable |
|---|------|---------------|-----------|-------------|
| 0 | **auto_merge_enabled** | Is auto-merge turned on for this project? | Boolean | Yes (project settings) |
| 1 | **ci_passed** | Did all CI checks pass? | Boolean | No |
| 2 | **confidence** | Is the AI confident in its diagnosis? | >= minConfidence (varies by trust level) | Yes |
| 3 | **lines_changed** | Is the fix small enough? | <= maxLinesChanged (varies by trust level) | Yes |
| 4 | **self_review** | Did the AI approve its own fix? | Score >= 70, not "reject" | Requires `requireSelfReview: true` |
| 5 | **substrate_simulate** | Is the I/O simulation risk low? | Risk score <= 40 | No |
| 6 | **eap_chain_verified** | Is the execution receipt chain valid? | Boolean | No |
| 7 | **prediction_safe** | Does the prediction engine say it's safe? | Risk score <= 40 | No |
| 8 | **security_scan** | Did the security scan pass? | Zero HIGH findings | No |
| 9 | **substrate_replay** | Did the I/O replay verify the fix? | Boolean | No |
| 10 | **e2e_staging** | Did the staging test pass? | Boolean | No |

Gates 5-10 only evaluate when data is available. If Substrate isn't configured, gates 5 and 9 are skipped (not failed).

## What Happens When a Gate Fails

The fix is created as a **draft PR** with all gate results shown in the PR body. You can review the fix, check the gate that failed, and merge manually if you're satisfied.

## Circuit Breaker

If a gate fails 5+ times consecutively within 2 hours for the same project, it's automatically bypassed for 15 minutes. This prevents a broken external service (e.g., staging server down) from blocking all remediations.

**Never bypassed:** `ci_passed`, `security_scan`, `self_review`, `auto_merge_enabled`. These gates are too critical to skip.

After the 15-minute cooldown, one real attempt is allowed. If it passes, the circuit closes (normal). If it fails again, the bypass resets for another 15 minutes.

Bypassed gates are noted in the PR body: `[CIRCUIT BREAKER: gate bypassed — consistently failing]`.

## Confidence Calibration

The **confidence** gate doesn't use the AI's raw score directly. InariWatch tracks what the AI predicted vs what actually happened (did the fix succeed or get reverted?). Over time, this builds a calibration profile per project.

- If the AI says 85% but historically succeeds only 70% of the time at that confidence → the gate uses ~70%
- Needs at least 10 completed remediations to activate
- With fewer than 10 data points, the raw AI confidence is used as-is

The PR body shows both values when calibration is active: `Confidence: 85% (calibrated: 72%)`.

## Default Thresholds by Trust Level

| Trust Level | Min Confidence | Max Lines Changed |
|-------------|---------------|-------------------|
| Rookie | Auto-merge disabled | 0 (no auto-merge) |
| Apprentice | 90% | 50 lines |
| Trusted | 80% | 100 lines |
| Expert | 70% | 200 lines |

See [Trust Levels](trust-levels.md) for how to progress.
