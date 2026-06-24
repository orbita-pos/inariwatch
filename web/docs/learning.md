# Learning from Failures

InariWatch gets smarter with every fix — especially the ones that fail. Two systems work together: **anti-pattern learning** prevents repeating mistakes, and **confidence calibration** adjusts the AI's self-assessment against reality.

## Anti-Pattern Learning

When a fix fails, InariWatch records what was attempted and why it failed:

- **CI failure** — the fix broke the build. Logged with CI error output.
- **Self-review rejected** — the AI's own review found problems. Logged with concerns.
- **Post-merge regression** — the fix caused a new error. Logged with regression details.

### How It's Used

Before generating the next fix for a similar error, the bot searches for past failures:

1. **Fingerprint match** — same error (based on normalized error fingerprint)
2. **File overlap** — different error but same files involved

If matches are found (up to 3), they're injected into the fix prompt:

```
PREVIOUS FAILED FIX ATTEMPTS for this error (DO NOT repeat these approaches):

Attempt 1: Changed error handler to catch TypeError
  Failed because: CI failure — broke 3 existing tests that depend on the error propagating

Attempt 2: Added null check in the middleware
  Failed because: Self-review rejected — the null check masks the root cause

You MUST try a DIFFERENT strategy than the ones listed above.
```

### What You See

- Event: `anti_patterns` with the count of injected patterns
- The PR description includes the attempt number if retries were needed

## Confidence Calibration

The AI returns a confidence score (0-100) with every diagnosis. InariWatch tracks whether that confidence matched reality.

### How It Works

After each remediation completes:
- **Success** (auto-merged, monitoring passed) → `recordCalibrationPoint(confidence, true)`
- **Failure** (CI fail, review reject, regression) → `recordCalibrationPoint(confidence, false)`

Over time, this builds a calibration profile. If the AI says "90% confident" but fixes at that level only succeed 65% of the time, the confidence is adjusted down.

### When It Activates

Calibration requires **at least 10 completed remediations** for the project. Before that, the raw AI confidence is used unchanged.

### What You See

- Event: `confidence_calibrated` with raw and adjusted values
- Gate evaluation uses the calibrated score, not the raw one
- PR body: `Confidence: 85% (calibrated: 72%)` when calibration is active

### Why This Matters

Most AI confidence scores are uncalibrated — the model's self-reported confidence doesn't match its actual accuracy. Calibration closes this gap per-project, making the auto-merge confidence gate meaningful rather than arbitrary.
