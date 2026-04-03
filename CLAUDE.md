# InariWatch — CLAUDE.md

## Project overview

InariWatch is an AI-powered monitoring SaaS for developers. It receives alerts from external services (Sentry, Vercel, GitHub, Datadog, Expo) and from your own app via `@inariwatch/capture`, enriches them with AI analysis, and helps teams respond faster with on-call scheduling, automated remediation, and local dev-mode fixes.

The product is live at **app.inariwatch.com**. There is also a demo account at `demo@inariwatch.com`.

## Repo structure

```
/
├── web/          # Next.js 15 app — the main product
│   ├── app/
│   │   ├── (auth)/       # Login, register, forgot-password, reset-password, signout
│   │   ├── (dashboard)/  # Authenticated app: alerts, projects, on-call, analytics, chat, settings, admin,
│   │   │                 #   community/fleet, integrations, onboarding, workspace, recordings
│   │   ├── (marketing)/  # Landing page, blog, docs, privacy, terms, trust, network
│   │   ├── admin/        # Internal admin panel
│   │   ├── api/          # API routes: webhooks, cron, auth, chat, notifications, slack, mcp,
│   │   │                 #   mobile, desktop, cli, actions, patterns, community, prediction, recordings
│   │   ├── invite/       # Workspace invite flow
│   │   ├── status/       # Public status page
│   │   ├── cli/          # CLI verification flow
│   │   └── download/     # Download page
│   │   └── api/mcp/      # Hosted MCP server (23 tools, 4 resources, 7 prompts)
│   ├── lib/
│   │   ├── ai/           # AI layer (14+ modules — see AI layer section below)
│   │   ├── db/           # Drizzle ORM schema + migrations (Neon PostgreSQL)
│   │   ├── services/     # Service layer — SSOT for all business logic
│   │   ├── auth/         # NextAuth config and helpers
│   │   ├── slack/        # Slack bot: client, blocks, send, actions, verify, remediation-bridge
│   │   ├── pollers/      # 8 pollers: sentry, vercel, github, expo, npm-audit, postgres, uptime, anomaly
│   │   ├── notifications/ # Email, push, mobile push, Telegram, Slack webhooks
│   │   ├── webhooks/     # Webhook ingestion logic
│   │   ├── code-intelligence/ # Code RAG: embeddings, indexer, parser, search, fix-replay
│   │   ├── telegram/     # Telegram bot: bot, format, send
│   │   └── mcp/          # MCP agent card
│   └── scripts/          # Demo recorder (Playwright), seed-demo, seed-blog
├── mcp/          # @inariwatch/mcp — npx init tool (auto-detect AI tools, install capture, configure MCP)
├── capture/      # @inariwatch/capture — npm SDK (zero deps, zero config)
├── vscode/       # VS Code extension — inline diagnostics, AI hover, sidebar
├── action/       # GitHub Action — AI risk assessment on PRs
├── cli/          # Rust CLI (local monitoring: dev, watch, simulate — serve-mcp deprecated)
├── bot-app/      # Expo React Native mobile app (push notifications, alert management)
├── desktop/      # Tauri desktop app (native alert viewer)
└── k6/           # Stress test suite (10 scenarios, all passing)
```

## Stack

- **Framework:** Next.js 15 (App Router), TypeScript
- **Database:** PostgreSQL via Neon + Drizzle ORM
- **Auth:** NextAuth (credentials + Google)
- **AI:** Multi-provider BYOK — Claude, OpenAI, Groq, Grok, DeepSeek, Gemini (6 providers)
- **Deploy:** Vercel
- **Email:** Resend (SMTP via Nodemailer)
- **Push notifications:** Web Push API + mobile push (Expo)
- **Slack:** @slack/web-api (OAuth bot, not just webhooks)
- **Telegram:** Bot API (webhooks + inline formatting)
- **Rate limiting:** DB-backed atomic UPSERT (safe across serverless instances)
- **Cron:** cron-job.org (external, not Vercel crons)
- **Substrate:** Optional I/O recording via @inariwatch/substrate-agent (ring buffer, auto-flush on error)
- **Cortex:** External execution data plane — serves EAP verification chain (optional, via EAP_SERVER_URL)
- **EAP:** Cryptographic proof chain for AI fix verification (Merkle trees, Ed25519)
- **Code Intelligence:** pgvector (1024D HNSW) + BM25 full-text search for semantic code search
- **Vulnerability Intelligence:** OSV.dev (primary, 17+ databases, no auth) + GitHub Advisory (fallback); lockfile parsing (package-lock.json, yarn.lock, Cargo.lock)
- **Security Scanning:** eslint-plugin-security (17 rules) + 19 regex patterns + AI review — runs in-memory on Vercel serverless, no CLI

## Key features

- **Alerts** — ingest from Sentry, Vercel, GitHub, Datadog, Expo, @inariwatch/capture via webhooks; free AI auto-analysis on arrival (GPT-4o-mini, no key required)
- **Ask Inari** — chat interface for querying alert history and getting AI recommendations (BYOK)
- **On-call scheduling** — rotation schedules per project, multi-level escalation policies, schedule overrides, timezone-aware
- **Auto-merge gates** — 11 safety gates: auto_merge_enabled, CI pass, confidence (>= threshold), lines changed (<= max), self-review (>= 70), substrate_simulate (risk <= 40), eap_chain_verified, prediction_safe (risk <= 40), security_scan (zero HIGH findings), substrate_replay (I/O replay pass), e2e_staging (staging E2E pass)
- **AI remediation** — full pipeline: diagnose → read code → generate fix → security scan → self-review → push → CI (3x retry) → PR → auto-merge gates → post-merge monitoring → escalation if failed; live terminal UI in dashboard
- **Autonomous mode** — `autoRemediate: true` auto-triggers remediation on critical alerts without human click; all 11 safety gates still apply
- **Auto-heal** — `autoHeal: true` when uptime detects site down (3 consecutive failures): rollback to last good Vercel deploy + start AI remediation; 10-min cooldown prevents loops
- **Prediction engine** — pre-deployment error detection with 3 layers: pattern matching against historical alerts, AI prediction on PR diffs, shadow replay of Substrate recordings against PR code; self-improving via community pattern feedback loop
- **Security scanning** — 3-layer scan built into remediation pipeline: (1) 17 ESLint rules via eslint-plugin-security (unsafe regex, child_process, CSRF, timing attacks, bidi chars, etc.), (2) 19 Semgrep-inspired regex patterns (SSRF, hardcoded secrets, prototype pollution, SQL injection, XSS, open redirect, insecure crypto, CORS wildcard), (3) AI security review (10 vulnerability categories via Claude); all 3 layers merge with dedup; no external API, runs serverless
- **Code Intelligence** — semantic code search via pgvector + BM25; indexes repos on GitHub connection; call graph tracking (callers/callees); hybrid vector + keyword search; 2 MCP tools (search_codebase, reindex_codebase)
- **Staging E2E verification** — auto-detects framework (Next.js, Express, generic); generates GitHub Actions E2E workflows to verify fix branches before merge
- **Substrate replay** — two modes: AI analysis (fast, serverless) + GitHub Action replay (real I/O verification); replays production recordings against fix code; confidence + risk scoring
- **Community fix network** — crowdsourced error fixes with success rates; when an error matches a known pattern, shows "47 teams fixed this, 96% success rate" with one-click apply; contribution pipeline anonymizes and strips PII
- **Escalation engine** — smart escalation to on-call when remediation fails; triggers: low confidence, fix failed, max retries, self-review rejected, regression detected
- **Status page automation** — auto-creates incidents on critical alerts, updates during remediation, resolves on fix; links to public status pages
- **Post-merge monitoring** — watches merged fixes for regressions (15-min health check); auto-reverts if regression detected
- **Slack bot** — full control surface: alert delivery with AI diagnosis, [Fix It] button triggers remediation in-thread, 10 slash commands (status, alerts, fix, oncall, link, help, trends, maintenance, rollback, search-fix), Ask Inari AI chat via @mention, deploy monitoring with 15-min health check, incident storm threads with postmortem generation
- **VS Code extension** — inline diagnostics (squiggly lines from stack traces), AI diagnosis on hover, sidebar alert list grouped by file, status bar unread count, local mode (port 9222, no cloud needed)
- **Capture SDK** — `@inariwatch/capture` on npm, zero deps, zero config; `npx @inariwatch/capture` auto-detects framework; env var driven (INARIWATCH_DSN); `/auto` import, `/next` plugin; optional Substrate I/O recording with `substrate: true`
- **Dev mode** — `inariwatch dev` catches local errors, diagnoses with AI, applies fixes directly to disk
- **GitHub Action** — AI risk assessment posted on every PR as a comment
- **Analytics** — alert trends, MTTR, severity breakdowns, AI analytics dashboard
- **Blog** — markdown-based, admin editor, newsletter subscriptions
- **Workspaces** — multi-tenant, invite system, role-based access
- **Admin panel** — internal user/workspace management
- **Mobile app** — Expo React Native (bot-app/): push notifications, alert list, remediation streaming
- **Desktop app** — Tauri (desktop/): native alert viewer with bearer token auth
- **Recordings** — Substrate recording viewer with video playback in dashboard

## AI layer

All AI modules live in `web/lib/ai/`. Key files:

| Module | File | Purpose |
|---|---|---|
| AI client | `client.ts` | Multi-provider dispatcher (6 providers) |
| Models | `models.ts` | Model definitions per provider |
| Key resolver | `get-key.ts` | BYOK key lookup |
| Prompts | `prompts.ts` | Prompt SSOT for all AI operations |
| Auto-analyze | `auto-analyze.ts` | Free AI analysis on alert arrival |
| Correlate | `correlate.ts` | Cross-alert correlation |
| Remediate | `remediate.ts` | Full remediation pipeline |
| Self-review | (in remediate.ts) | AI reviews its own fix |
| Auto-merge gates | `auto-merge-gates.ts` | 11 safety gates before merge |
| Risk assessment | `risk-assessment.ts` | PR risk analysis |
| Postmortem | `postmortem.ts` | Auto-generated post-mortems |
| Community fix lookup | `community-fix-lookup.ts` | Match errors to crowdsourced fixes |
| Contribute fix | `contribute-fix.ts` | Anonymize and contribute fixes to network |
| Prediction | `prediction.ts` | 3-layer pre-deploy prediction engine |
| Prediction feedback | `prediction-feedback.ts` | Accuracy tracking, self-improvement |
| Shadow replay | `shadow-replay.ts` | Replay recordings against PR code |
| Substrate replay | `substrate-replay.ts` | I/O replay verification (AI + Action) |
| Security scan | `security-scan.ts` | 3-layer scan: 17 ESLint rules (eslint-plugin-security) + 19 regex patterns + AI review |
| Staging E2E | `staging-e2e.ts` | Generate E2E workflows for fix verification |
| Post-merge monitor | `post-merge-monitor.ts` | Watch for regressions after merge |
| Escalation engine | `escalation-engine.ts` | Smart escalation to on-call |
| Status page automation | `status-page-automation.ts` | Auto incident lifecycle management |
| Context gatherer | `context-gatherer.ts` | Gather Vercel/Sentry/GitHub context |
| Fingerprint | `fingerprint.ts` | Error fingerprinting for dedup |
| Trust level | `trust-level.ts` | Compute trust level from track record (Rookie → Expert), apply to gate thresholds |

## Service layer — single source of truth

All business logic lives in `web/lib/services/`. Every surface (MCP, Slack, dashboard, extension, cron) calls these services instead of reimplementing queries.

| Service | File | Functions |
|---|---|---|
| Alerts | `lib/services/alerts.service.ts` | queryAlerts, getAlert, silenceAlert, acknowledgeAlert, reopenAlert, getAlertStats, getErrorTrends |
| Diagnosis | `lib/services/diagnosis.service.ts` | diagnoseAlert (uses `lib/ai/prompts.ts` as prompt SSOT) |
| Vercel | `lib/services/vercel.service.ts` | getRecentDeployments, rollbackToDeployment, getBuildLogs |
| Chat | `lib/services/chat.service.ts` | gatherChatContext, buildContextString, SYSTEM_OPS |
| URL validation | `lib/services/url-validation.ts` | isSafeUrl (SSRF protection) |
| Auto-rollback | `lib/services/auto-rollback.ts` | Automatic Vercel rollback on deploy failures |
| Code Intelligence | `lib/services/code-intelligence.service.ts` | Hybrid search, reindexing, call graph |
| GitHub API | `lib/services/github-api.ts` | Raw GitHub REST API calls |
| Vercel API | `lib/services/vercel-api.ts` | Raw Vercel API calls |

**Rules:**
- Services receive typed params, return typed data — no HTTP/MCP/Slack protocol objects
- Services handle their own DB queries — consumers don't touch Drizzle directly for covered operations
- When adding a new operation, add it to the service first, then wire it to each surface

**Surfaces that consume services:**
- MCP web tools (`web/app/api/mcp/tools/*.ts`) — 23 tools
- Slack bot (`web/lib/slack/actions.ts`) — acknowledgeAlertCore, resolveAlertCore
- Dashboard (`web/app/(dashboard)/alerts/[id]/ai-actions.ts`)
- Mobile API (`web/app/api/mobile/`)
- Desktop API (`web/app/api/desktop/`)

**Not yet extracted (acceptable — no duplication):**
- Remediation: all surfaces already call `runRemediation()` from `lib/ai/remediate.ts`
- On-call: centralized in `lib/on-call.ts`
- Risk assessment: `lib/ai/risk-assessment.ts` (MCP has a simpler version, intentional)

## Pollers

All pollers live in `web/lib/pollers/`. Cron-triggered via `/api/cron/poll/*`.

| Poller | File | What it monitors |
|---|---|---|
| Sentry | `sentry.ts` | Sentry issues and events |
| Vercel | `vercel-api.ts` | Deployment failures, build errors |
| GitHub | `github.ts` | Repository events |
| Expo | `expo.ts` | EAS build failures, deploy errors, update failures |
| npm/Cargo audit | `npm-audit.ts` | CVEs in dependencies (OSV.dev primary, GitHub Advisory fallback); lockfile parsing for transitive deps; version range matching |
| Postgres | `postgres.ts` | Database health monitoring |
| Uptime | `uptime.ts` | Site availability (triggers auto-heal) |
| Anomaly | `anomaly.ts` | Anomaly detection and trend analysis |

## MCP server

Hosted at `mcp.inariwatch.com` (middleware rewrite → `POST /api/mcp`). Streamable HTTP, JSON-RPC 2.0.

- **23 tools** — query_alerts, get_status, get_uptime, get_build_logs, get_substrate_context, get_root_cause, assess_risk, get_postmortem, search_community_fixes, trigger_fix, rollback_vercel, silence_alert, submit_feedback, run_check, ask_inari, get_error_trends, create_uptime_monitor, run_health_check, reproduce_bug, simulate_fix, verify_remediation, search_codebase, reindex_codebase
- **4 resources** — alerts/critical, alerts/recent, status/overview, remediations/active
- **7 prompts** — diagnose, status-report, fix-this, post-deploy-check, weekly-summary, production-health-check, daily-report
- **Auth:** Bearer tokens (SHA-256 hashed), OAuth 2.0 + PKCE, granular scopes (read/write/execute)
- **Rate limits:** cheap (200/min), moderate (30/min), expensive (5/min) per tool
- **Audit trail:** every tool call logged to audit_logs
- **Setup:** `npx @inariwatch/mcp init` (detects AI tools, installs capture, configures MCP — init only, not a multi-command CLI)

CLI Rust `serve-mcp` is deprecated — web MCP is the source of truth. CLI keeps: init, add, connect, config, dev, watch, simulate.

## API routes

66+ routes across 15+ categories in `web/app/api/`:

| Category | Routes | Notes |
|---|---|---|
| Webhooks | capture, sentry, vercel, github, datadog, expo | Per-integration via `[integrationId]` |
| Cron | poll (sentry, vercel, github, expo, npm, postgres, uptime), escalate, digest, deploy-monitor | External cron-job.org triggers |
| Auth | NextAuth catch-all, verify-email | |
| CLI | auth/start, auth/poll, link | Device flow auth for Rust CLI |
| Chat | chat | Ask Inari AI chat |
| Notifications | push/subscribe, ses-webhook, track/open, track/click, unsubscribe | |
| Slack | events, commands, interactions, oauth, oauth/callback | 10 slash commands |
| MCP | route, events, oauth/authorize, oauth/token, .well-known | 23 tool implementations |
| Mobile | alerts, alerts/[id], push, version, remediation/[id] | Expo mobile app backend |
| Desktop | alerts | Tauri desktop backend |
| Actions | ack, resolve | Quick alert actions |
| Alerts | export, stream | SSE streaming + CSV export |
| Patterns/Community | patterns/search, trending, fleet, contribute, rate; community/fixes, fixes/[id], fixes/[id]/report | Community fix network |
| Code Intelligence | code-intelligence/index | Codebase indexation trigger |
| Remediation | remediation/stream/[sessionId] | SSE streaming of remediation progress |
| Prediction | prediction | PR risk prediction engine |
| Recordings | recordings/upload | Substrate recording upload |
| Telegram | telegram/webhook | Telegram bot webhook |
| Status | status/[slug]/widget | Embeddable status widget |
| Invites | invites/[token] | Workspace invite acceptance |
| Test | test/create-alert | Dev/demo alert seeding |

## Database migrations

Migrations live in `web/lib/db/migrations/`. Run them with Drizzle Kit. Current: `0031_schema_alignment.sql`.

Recent migrations:
- 0025: MCP OAuth clients
- 0026: Telegram user links
- 0027: Telegram message links
- 0028: Code Intelligence (pgvector + BM25)
- 0029: Fix replay embeddings
- 0030: Missing enum values (push, datadog, uptime, expo)
- 0031: Schema alignment fixes

## Environment variables

See `web/.env.example`. Key vars:
- `DATABASE_URL` — Neon PostgreSQL connection string
- `NEXTAUTH_SECRET`, `NEXTAUTH_URL`
- `ENCRYPTION_KEY` — for encrypting API keys in DB
- `CRON_SECRET` — authenticates cron-job.org requests
- `PLATFORM_AI_KEY` — platform-level AI key for free auto-analysis
- `RESEND_API_KEY` — Resend email service
- `ADMIN_EMAIL` — grants access to `/admin`
- `APP_URL` — used for cron fan-out (fallback: `VERCEL_URL`)
- `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` — Slack bot OAuth
- `EAP_SERVER_URL` — optional, points to Cortex server for cryptographic verification
- `EXPO_ACCESS_TOKEN` — Expo EAS API authentication
- `TELEGRAM_WEBHOOK_SECRET` — Telegram bot webhook verification
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL` — Web Push API
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` — GitHub OAuth
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Google OAuth

## Security considerations

- CSP hardened (`unsafe-eval` removed in production, only in dev)
- XSS protection: quotes escaped in markdown link URLs
- Rate limiting on auth endpoints (DB-backed, not in-memory)
- `/admin` protected in middleware
- Middleware protects: /dashboard, /projects, /alerts, /chat, /integrations, /settings, /admin, /recordings
- API routes handle their own auth (allows public webhooks)
- MCP OAuth: CSRF protection via HTTP-only cookie + token validation
- Encryption: API keys encrypted at rest via ENCRYPTION_KEY

## Stress testing (k6)

10-scenario k6 stress test suite in `k6/`. All 10 passed (2026-04-03):

| # | Scenario | What it validates | Result |
|---|----------|------------------|--------|
| 1 | `webhook-storm` | Capture webhook ingestion under burst load, rate limiting | p95: 358ms, 0% error |
| 2 | `mcp-rate-limits` | 3 MCP rate limit tiers (cheap/moderate/expensive) | All tiers enforced |
| 3 | `sse-streaming` | 50 concurrent SSE connections, reconnection | Connections stable |
| 4 | `alert-dedup` | Fingerprinting, dedup accuracy, storm detection | Dedup working |
| 5 | `auth-bruteforce` | Login brute force protection, device flow rate limits | Rate limiting enforced |
| 6 | `cron-fanout` | 7 sub-pollers in parallel, overlap handling | No race conditions |
| 7 | `neon-saturation` | DB concurrency: webhooks + MCP + cron simultaneously | Neon stable under load |
| 8 | `push-serialization` | Push notification pipeline under burst | Pipeline stable |
| 9 | `auto-heal` | 3 failures → auto-heal, cooldown, race conditions | Single heal, cooldown works |
| 10 | `full-incident` | Complete incident lifecycle end-to-end (deploy fail → error burst → uptime → auto-heal → MCP verify → recovery) | 10/10 phases, 100% checks |

Run: `bash k6/run-all.sh` (requires k6 installed + `k6/.env` with secrets)

## Demo recording

```bash
DEMO_URL=https://app.inariwatch.com DEMO_EMAIL=demo@inariwatch.com DEMO_PASSWORD=Demo1234! npx tsx scripts/record-demo.ts
```

Outputs `.webm` to `scripts/demo-output/`. Convert to GIF:
```bash
# Run convert.bat (saved at %TEMP%/convert.bat) in PowerShell
& "$env:TEMP\convert.bat"
```

## Developer context

- **Owner:** Jesus Bernal (@JesusBrDev) — solo founder, Mexico
- **Languages used across projects:** Rust, Go, TypeScript
- **Style:** Keep it simple, no over-engineering, no unnecessary abstractions
- **Avoid:** Mocks in tests, unsafe-eval in CSP, in-memory rate limiters on serverless
