# Trust Levels

InariWatch starts conservative and earns more autonomy as it proves it works for your project. New projects begin as **Rookie** — the bot can diagnose and fix, but never auto-merges. Over time, with successful fixes and elapsed days, it progresses.

## The 4 Levels

| Level | Auto-Merge | Min Confidence | Max Lines | Requirements |
|-------|-----------|---------------|-----------|-------------|
| **Rookie** | Disabled | N/A | 0 | Default for new projects |
| **Apprentice** | Enabled | 90% | 50 | 3+ fixes, 50%+ success, 7+ days |
| **Trusted** | Enabled | 80% | 100 | 5+ fixes, 70%+ success, 14+ days |
| **Expert** | Enabled | 70% | 200 | 10+ fixes, 85%+ success, 30+ days |

## How Progression Works

Trust is computed from your project's remediation history:
- **Total fixes** — how many times the bot has run
- **Success rate** — fixes that merged and passed post-merge monitoring without revert
- **Age** — days since the first fix (prevents gaming trust with rapid trivial fixes)

All three conditions must be met. A project with 10 fixes at 90% success but only 5 days old stays at Apprentice.

## What Changes

Trust levels only **tighten** thresholds, never relax them. If you set `minConfidence: 85` in your project settings but your trust level requires 90%, the bot uses 90%.

At **Rookie** level, auto-merge is completely disabled regardless of your settings. The bot still runs the full pipeline and creates draft PRs.

## Reverted Fixes

A fix that gets auto-reverted by the post-merge monitor counts as a failure. This lowers your success rate and can delay trust progression.
