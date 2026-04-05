# InariWatch Competitive Analysis

## Feature Matrix

| Feature | InariWatch | Copilot Autofix | Snyk DeepCode | CodeGuru/Q | Harness AIDA | PagerDuty AIOps |
|---------|-----------|-----------------|---------------|------------|-------------|-----------------|
| **Error Detection** | Multi-source (Sentry, Vercel, GitHub, Datadog, Expo, Capture SDK) | GitHub code scanning only | Snyk scanner only | CodeGuru profiler | Error tracking | Event correlation |
| **AI Diagnosis** | Multi-provider BYOK (6 providers) | GitHub Copilot (GPT-4) | DeepCode engine | CodeGuru ML | AIDA | ML correlation |
| **Auto-Fix Generation** | Full file generation + multi-attempt | Fix suggestions only | Fix suggestions only | Java/Python only | No code fixes | Runbooks only |
| **Security Scanning** | 3-layer (ESLint + regex + AI review) | CodeQL | Deep SAST/SCA | Java security | N/A | N/A |
| **Self-Review** | AI reviews its own fix (score 0-100) | N/A | N/A | N/A | N/A | N/A |
| **CI Verification** | Wait for CI, retry 3x with error context | N/A | N/A | N/A | CI/CD pipeline | N/A |
| **Staging Deploy** | Ephemeral Docker + Playwright bot | N/A | N/A | N/A | Canary deploy | N/A |
| **Browser Replay** | Replays exact user session (Substrate + rrweb) | N/A | N/A | N/A | N/A | N/A |
| **AI Vision** | Screenshot before/after with BYOK vision | N/A | N/A | N/A | N/A | N/A |
| **Response Body Diffing** | Deep recursive comparison (4 levels) | N/A | N/A | N/A | N/A | N/A |
| **Auto-Merge** | 11 independent gates + circuit breaker | N/A (suggestions only) | N/A | N/A | Feature flags | N/A |
| **Post-Merge Monitor** | 10 min phased (Sentry + uptime + fingerprint) | N/A | N/A | N/A | Canary analysis | Incident tracking |
| **Auto-Revert** | Automatic revert PR + merge on regression | N/A | N/A | N/A | Rollback | Rollback |
| **Trust Levels** | Progressive (Rookie → Expert) with age gates | N/A | N/A | N/A | N/A | N/A |
| **Incident Correlation** | Groups concurrent errors from same root cause | N/A | N/A | N/A | N/A | ML correlation |
| **Learning from Failures** | Anti-pattern injection from past failed fixes | N/A | N/A | N/A | N/A | N/A |
| **Confidence Calibration** | Tracks AI predictions vs reality, adjusts scores | N/A | N/A | N/A | N/A | N/A |
| **Community Fixes** | Cross-project fingerprint matching + crowdsourced patterns | N/A | Snyk advisories | N/A | N/A | N/A |
| **Crash Recovery** | Pipeline checkpoints + orphan staging cleanup | N/A | N/A | N/A | N/A | N/A |
| **Concurrency Control** | File-level locking + remediation queue | N/A | N/A | N/A | N/A | N/A |
| **Graceful Degradation** | Service health tracking, auto-skip down services | N/A | N/A | N/A | N/A | N/A |
| **Multi-Platform** | Web + CLI + Slack bot + Telegram + VS Code + Mobile + Desktop | GitHub only | IDE + CI | AWS Console | Web | Web + Mobile |

## Unique Selling Points (only InariWatch has these)

1. **Full autonomous loop**: Error → AI diagnosis → code fix → security scan → self-review → CI → staging → browser replay → AI vision → 11 gates → merge → monitor → revert. No human required. No other tool does all of this.

2. **AI that sees the page**: Before/after screenshot comparison using the user's own AI provider. The bot literally looks at what the user saw when the error happened and what the page looks like after the fix. Zero competitors have this.

3. **Substrate session replay in staging**: The Playwright bot replays the exact HTTP requests and UI interactions from the original error recording. Not synthetic tests — the actual user session that broke. Nobody else does this.

4. **Learning from failures**: When a fix fails (CI, review reject, regression), InariWatch records why and injects it as anti-patterns into future fix prompts. The bot gets smarter per-project over time. No competitor tracks failure patterns.

5. **11 independent safety gates with circuit breaker**: Most tools are binary (merge or don't). InariWatch has 11 independently evaluated gates with a circuit breaker that bypasses consistently failing gates (e.g., staging server down) while never bypassing critical ones (CI, security).

## Remaining Gaps

1. **No canary/gradual rollout** — Harness has phased canary deploys. InariWatch does binary (merge or revert). The post-merge monitor phases (fast/normal/relaxed) partially address this but don't do traffic splitting.

2. **No feature flag integration** — LaunchDarkly and Harness can roll out fixes behind feature flags. InariWatch merges directly to main.

3. **No IDE integration for fix preview** — Copilot Autofix shows the fix inline in GitHub. InariWatch's VS Code extension shows diagnostics but not the actual fix preview before merge.

4. **No automated test generation that persists** — InariWatch generates tests during self-review but doesn't persist them in the repo. Copilot can suggest tests that become part of the codebase.

5. **No multi-language deep analysis** — CodeGuru has deep Java/Python profiling. InariWatch's security scan is language-agnostic (regex) but lacks language-specific deep analysis.

## What to Build Next (priority order)

1. **Canary monitoring phases** — Already partially implemented in post-merge-monitor.ts structure. Add phased polling (30s/1min/2min) with different regression thresholds per phase.

2. **Fix preview in VS Code extension** — Show the AI-generated fix as an inline diff in the editor before the PR is created. Let the developer approve/reject from the IDE.

3. **Persistent test generation** — When the bot generates a fix, also generate a regression test and include it in the PR. This builds the test suite over time.

4. **Feature flag-gated deploys** — Integration with LaunchDarkly/Unleash to roll out fixes behind flags instead of direct merge.
