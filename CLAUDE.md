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
│   │   └── api/mcp/      # Hosted MCP server (25 tools, 4 resources, 7 prompts)
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
├── cli/          # Rust CLI (local monitoring: dev, watch, simulate — serve-mcp deprecated, WhatsApp stub)
├── worker/       # Hetzner AI worker — runs container agent loop on localhost Docker (Node.js)
├── bot-app/      # Expo React Native mobile app (push notifications, alert management)
├── desktop/      # Tauri desktop app (native alert viewer)
└── k6/           # Stress test suite (10 scenarios, all passing)
```

## GitHub repositories (open-core model)

The project follows an **open-core** strategy: the monorepo is private, and only user-facing packages are public.

| Repo | Visibility | Contents |
|------|-----------|----------|
| `orbita-pos/inariwatch` | **PRIVATE** | This monorepo — web, AI, CLI, desktop, mobile, k6 |
| `orbita-pos/inariwatch-capture` | PUBLIC | `@inariwatch/capture` SDK (mirror of `capture/`) |
| `orbita-pos/inariwatch-mcp` | PUBLIC | `@inariwatch/mcp` init tool (mirror of `mcp/`) |
| `orbita-pos/inariwatch-vscode` | PUBLIC | VS Code extension (mirror of `vscode/`) |
| `orbita-pos/inariwatch-action` | PUBLIC | GitHub Action for PR risk assessment |
| `orbita-pos/eap` | **PRIVATE** | EAP: Merkle + Ed25519 cryptographic verification (6 Rust crates) |
| `orbita-pos/substrate` | **PRIVATE** | Substrate: I/O recording + deterministic replay (10 Rust crates) |
| `orbita-pos/inariwatch-agent` | **PRIVATE** | InariWatch Agent: kernel-level observability via eBPF (C + Rust, 50 files) |

**Rules:**
- Never make `inariwatch`, `eap`, `substrate`, or `inariwatch-agent` public — these contain core IP
- When updating `capture/`, `mcp/`, or `vscode/` in this monorepo, the public mirrors should also be updated
- Public repos must never reference internal paths, private infra, or secrets
- npm packages (`@inariwatch/capture`, `@inariwatch/mcp`) publish from the public repos

## Stack

- **Framework:** Next.js 15 (App Router), TypeScript
- **Database:** PostgreSQL via Neon + Drizzle ORM
- **Auth:** NextAuth (credentials + Google)
- **AI:** Platform-funded (all features work out of the box via PLATFORM_AI_KEY) + optional BYOK — Claude, OpenAI, Groq, Grok, DeepSeek, Gemini (6 providers); MCP uses sampling-first (client LLM does analysis)
- **Deploy:** Vercel
- **Email:** Resend (SMTP via Nodemailer)
- **Push notifications:** Web Push API + mobile push (Expo)
- **Slack:** @slack/web-api (OAuth bot, not just webhooks)
- **Telegram:** Bot API (webhooks + inline formatting)
- **Rate limiting:** Redis-first (Upstash) with DB fallback — ~1ms via `@upstash/ratelimit`
- **Redis:** Upstash (Vercel-facing: rate limiting, AI cache, dedup, service health, Slack cache) + self-hosted on Hetzner (future: remediation state, job queue)
- **Cron:** Go scheduler on Hetzner (replaces cron-job.org) — 5 jobs, same Vercel routes, Bearer auth
- **Substrate:** Optional I/O recording via @inariwatch/substrate-agent (ring buffer, auto-flush on error)
- **Cortex:** External execution data plane — serves EAP verification chain (optional, via EAP_SERVER_URL)
- **EAP:** Cryptographic proof chain for AI fix verification (Merkle trees, Ed25519)
- **Code Intelligence:** pgvector (1024D HNSW) + BM25 full-text search for semantic code search
- **Vulnerability Intelligence:** OSV.dev (primary, 17+ databases, no auth) + GitHub Advisory (fallback); lockfile parsing (package-lock.json, yarn.lock, Cargo.lock)
- **Security Scanning:** eslint-plugin-security (17 rules) + 19 regex patterns + AI review — runs in-memory on Vercel serverless, no CLI
- **Dogfooding:** InariWatch monitors itself via `@inariwatch/capture/next` wrapper + `instrumentation.ts`

## Hetzner infrastructure (CX22 — 2 vCPU, 4GB RAM)

The Hetzner server runs 5 services alongside each other:

| Service | Port | Process | Purpose |
|---|---|---|---|
| Go staging server | 9400 | `inari-staging` (systemd) | Container lifecycle (create/exec/write/delete), cron scheduler |
| Node.js AI worker | 9401 | `inari-worker` (systemd) | Runs container agent AI loop on localhost Docker |
| Redis | 6379 | Docker container | Remediation state, job queue (Hetzner-local) |
| Caddy | 443 | systemd | TLS termination, routes `/worker/*` → 9401, rest → 9400 |
| InariWatch Agent | — | `inariwatch-agent` (binary) | Kernel-level observability via eBPF, sends events to InariWatch cloud |

**Cron scheduler** (built into Go server): 5 jobs trigger Vercel routes with `Bearer CRON_SECRET`. Replaces cron-job.org.

| Job | Route | Interval |
|---|---|---|
| poll | /api/cron/poll | 2 min |
| uptime | /api/cron/uptime | 1 min |
| escalate | /api/cron/escalate | 2 min |
| deploy-monitor | /api/cron/deploy-monitor | 1 min |
| digest | /api/cron/digest | 1 hr |

**Redis caching layer** (Upstash for Vercel, self-hosted for Hetzner):
- Rate limiting: `@upstash/ratelimit` sliding window (~1ms vs 30-50ms DB)
- AI diagnosis cache: same fingerprint = cached response (1h TTL)
- Alert dedup: `SET NX` fast-path (24h TTL, skips 7-9 DB queries for duplicates)
- Email rate limiting: 3 `INCR` pipelined (vs 3-4 DB queries)
- Service health: shared across Vercel instances via `HSET`
- Slack token cache: survives cold starts
- All operations have DB/in-memory fallback if Redis unavailable

**AI cost optimizations:**
- Prompt caching: `cache_control: { type: "ephemeral" }` on system prompts (~$0.25-0.30 savings/remediation)
- Model routing: self-review + security scan use analysis model (Haiku) instead of Sonnet
- Estimated cost: ~$0.25/remediation (down from ~$0.56)

## Key features

- **Alerts** — ingest from Sentry, Vercel, GitHub, Datadog, Expo, @inariwatch/capture via webhooks; free AI auto-analysis on arrival (GPT-4o-mini, no key required)
- **Ask Inari** — chat interface for querying alert history and getting AI recommendations (platform-funded on dashboard/Slack/Telegram; sampling-first on MCP — client LLM does the analysis)
- **On-call scheduling** — rotation schedules per project, multi-level escalation policies, schedule overrides, timezone-aware
- **Auto-merge gates** — 11 safety gates: auto_merge_enabled, CI pass, confidence (>= threshold), lines changed (<= max), self-review (>= 70), substrate_simulate (risk <= 40), eap_chain_verified, prediction_safe (risk <= 40), security_scan (zero HIGH findings), substrate_replay (I/O replay pass), e2e_staging (staging E2E pass)
- **AI remediation** — full pipeline: diagnose → read code → generate fix → security scan → self-review → push → CI (3x retry) → PR → auto-merge gates → post-merge monitoring → escalation if failed; live terminal UI in dashboard
- **Autonomous mode** — `autoRemediate: true` auto-triggers remediation on critical alerts without human click; all 11 safety gates still apply
- **Auto-heal** — `autoHeal: true` when uptime detects site down (3 consecutive failures): rollback to last good Vercel deploy + start AI remediation; 10-min cooldown prevents loops
- **Prediction engine** — pre-deployment error detection with 3 layers: pattern matching against historical alerts, AI prediction on PR diffs, shadow replay of Substrate recordings against PR code; self-improving via community pattern feedback loop; **auto-triggers on PR opened/synchronize** via GitHub webhook (deduped via Redis 60s TTL)
- **Security scanning** — 3-layer scan built into remediation pipeline: (1) 17 ESLint rules via eslint-plugin-security (unsafe regex, child_process, CSRF, timing attacks, bidi chars, etc.), (2) 19 Semgrep-inspired regex patterns (SSRF, hardcoded secrets, prototype pollution, SQL injection, XSS, open redirect, insecure crypto, CORS wildcard), (3) AI security review (10 vulnerability categories via Claude); all 3 layers merge with dedup; no external API, runs serverless
- **Code Intelligence** — semantic code search via pgvector + BM25; indexes repos on GitHub connection; call graph tracking (callers/callees); hybrid vector + keyword search; 2 MCP tools (search_codebase, reindex_codebase)
- **Staging E2E verification** — auto-detects framework (Next.js, Express, generic); generates GitHub Actions E2E workflows to verify fix branches before merge
- **Substrate replay** — two modes: AI analysis (fast, serverless) + GitHub Action replay (real I/O verification); replays production recordings against fix code; confidence + risk scoring
- **Community fix network** — crowdsourced error fixes with success rates; when an error matches a known pattern, shows "47 teams fixed this, 96% success rate" with one-click apply; contribution pipeline anonymizes and strips PII; **auto-contributes** after successful post-merge monitoring (no manual approval needed)
- **Escalation engine** — smart escalation to on-call when remediation fails; triggers: low confidence, fix failed, max retries, self-review rejected, regression detected
- **Status page automation** — auto-creates incidents on critical alerts, updates during remediation, resolves on fix; links to public status pages
- **Post-merge monitoring** — watches merged fixes for regressions (**10-min** health check, canary phases at 30s/60s/2min polling intervals — see `lib/ai/post-merge-monitor.ts:19`); auto-reverts if regression detected. Distinct from the Slack deploy health check (15 min, `lib/services/deploy-health-check.ts`) — do not confuse.
- **Slack bot** — full control surface: alert delivery with AI diagnosis, [Fix It] button triggers remediation in-thread, 14 slash commands (status, alerts, fix, oncall, oncall swap, trends, ask, uptime, rollback, maintenance, maintenance list, search, integrations, link, help), 10 interactive button actions, Ask Inari AI chat via @mention, deploy monitoring with 15-min health check, incident storm threads with postmortem generation
- **Telegram bot** — 15 commands (/start, /help, /link, /status, /alerts, /trends, /uptime, /oncall, /oncall swap, /ask, /rollback, /maintenance, /maintenance list, /search, /integrations, /fix_ID), 13 inline button callbacks, on-call tagging for critical alerts, auto-attached substrate recordings and community fixes
- **VS Code extension** — inline diagnostics (squiggly lines from stack traces), AI diagnosis on hover, sidebar alert list grouped by file, status bar unread count, local mode (port 9222, no cloud needed)
- **Capture SDK** — `@inariwatch/capture` on npm, zero deps, zero config; `npx @inariwatch/capture` auto-detects framework; env var driven (INARIWATCH_DSN); `/auto` import, `/next` plugin; optional Substrate I/O recording with `substrate: true`
- **Dev mode** — `inariwatch dev` catches local errors, diagnoses with AI, applies fixes directly to disk
- **GitHub Action** — AI risk assessment posted on every PR as a comment
- **Analytics** — alert trends, MTTR, severity breakdowns, AI analytics dashboard
- **Blog** — markdown-based, admin editor (`web/app/admin/blog/` — create, edit, delete posts), newsletter subscriptions via `blogSubscribers` table
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
| Key resolver | `get-key.ts` | Platform key + optional BYOK resolution |
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
| Managed Agent | `managed-agent.ts` | Claude Managed Agents integration (beta — currently disabled) |
| Container Agent | `container-agent.ts` | Hetzner container agent (6 tools: read, write, grep, exec, submit_fix) |
| Container Worker | `worker/src/` | Standalone Node.js worker — runs container agent loop on Hetzner localhost (40 turns, ~1ms tools) |
| Agentic loop | `agentic-loop.ts` | Tool-use exploration loop (4 tools: read_file, search_code, list_directory, submit_fix) |
| Service health | `service-health.ts` | Graceful degradation for external services, shared across instances via Redis |
| Redis client | `lib/redis.ts` | Upstash Redis singleton (rate limiting, AI cache, dedup, service health, Slack cache) |

### Remediation fix generation — 3 strategies (cascading fallback)

| Strategy | File | When | How |
|---|---|---|---|
| **1. Managed Agent** | `managed-agent.ts` | `MANAGED_AGENT_ENABLED=true`, attempt 1 only | Anthropic container: clone → explore → fix → tsc/build/test → push. Agent pushes directly to GitHub. |
| **2. Container Agent (Worker)** | `container-agent.ts` + `worker/` | `WORKER_URL` set, attempt 1 only | Hetzner worker runs AI loop on localhost Docker: clone → 6 tools (read, write, grep, exec) → tsc/build/test → push via GitHub API. **40 turns, ~1ms tool calls, no timeout.** |
| **2b. Container Agent (Vercel)** | `container-agent.ts` | `CONTAINER_AGENT_ENABLED=true` + `STAGING_SERVER_URL`, no `WORKER_URL` | Same as above but AI loop runs on Vercel (15 turns, 80-120ms tool calls). Fallback when worker unavailable. |
| **3. Agentic loop** | `agentic-loop.ts` | attempt 1, provider supports tool_use | Haiku explores (turns 1–12), Sonnet fixes (turns 13–15). 4 tools via GitHub API. Max 15 turns. |
| **4. Single-shot** | (in `remediate.ts`) | retries, Gemini, or agentic fallback | One prompt with full context + anti-patterns from failed attempts. |

**⚠ Managed Agents status:** `MANAGED_AGENT_ENABLED=false` in production. The Anthropic Managed Agents API (`managed-agents-2026-04-01`) is still in beta and was causing failures (wrong branch pushes, test-only commits, session billing leaks). Do NOT set to `true` until the API exits beta and is stable.

**Container Agent status:** DEPLOYED + WORKER ACTIVE (2026-04-09). Two modes:
- **Worker mode** (`WORKER_URL` set): AI loop runs on Hetzner Node.js worker (`worker/src/`), 40 turns, Docker on localhost (~1ms tool calls), no Vercel timeout. ~$0.25/fix with prompt caching.
- **Vercel mode** (fallback): AI loop on Vercel, 15 turns, HTTP round-trips to Hetzner (~80-120ms/call). Activates when worker unavailable.
Security: command whitelist + subshell/backtick/semicolon blocking, path traversal protection, symlink validation, tmpfs disk limits, input size limits, WORKER_URL scheme validation (must be HTTPS or localhost).

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
- MCP web tools (`web/app/api/mcp/tools/*.ts`) — 25 tools
- Slack bot (`web/lib/slack/actions.ts`) — acknowledgeAlertCore, resolveAlertCore
- Dashboard (`web/app/(dashboard)/alerts/[id]/ai-actions.ts`)
- Mobile API (`web/app/api/mobile/`)
- Desktop API (`web/app/api/desktop/`)
- Extension API (`web/app/api/extension/`) — alerts, read, resolve, SSE stream

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

Hosted at `mcp.inariwatch.com` (middleware rewrite → `POST /api/mcp`). Streamable HTTP, JSON-RPC 2.0. Custom implementation (no SDK dependency).

- **25 tools** — query_alerts, get_status, get_uptime, get_build_logs, get_substrate_context, get_root_cause, assess_risk, get_postmortem, search_community_fixes, trigger_fix, rollback_vercel, silence_alert, acknowledge_alert, reopen_alert, submit_feedback, run_check, ask_inari, get_error_trends, create_uptime_monitor, run_health_check, reproduce_bug, simulate_fix, verify_remediation, search_codebase, reindex_codebase
- **4 resources** — alerts/critical, alerts/recent, status/overview, remediations/active
- **7 prompts** — diagnose, status-report, fix-this, post-deploy-check, weekly-summary, production-health-check, daily-report
- **Sampling-first:** 4 analysis tools (get_root_cause, ask_inari, assess_risk, simulate_fix) return `_sampling_request` with prompt + context for the client LLM to process. Server does zero AI calls for analysis. `trigger_fix` uses platform key (or user's BYOK key if configured) for server-side remediation pipeline.
- **sampling/createMessage:** endpoint persists client LLM results to `aiReasoning` (alert-based tools) or acknowledges (non-alert tools)
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
| Slack | events, commands, interactions, oauth, oauth/callback | 14 slash commands, 10 button actions |
| MCP | route, events, oauth/authorize, oauth/token, .well-known | 23 tool implementations |
| Mobile | alerts, alerts/[id], push, version, remediation/[id] | Expo mobile app backend |
| Desktop | alerts | Tauri desktop backend |
| Extension | alerts, alerts/[id]/resolve, alerts/stream | VS Code extension backend (Bearer token auth) |
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
- `CRON_SECRET` — authenticates cron requests (Go scheduler on Hetzner + legacy cron-job.org)
- `PLATFORM_AI_KEY` — OpenAI key that funds ALL AI features for users without BYOK ($100/day budget cap)
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
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — Upstash Redis (rate limiting, AI cache, dedup)
- `WORKER_URL` — Hetzner AI worker URL (enables worker mode for container agent)
- `STAGING_API_SECRET` — authenticates requests to Hetzner Go server + worker

## Security considerations

- CSP hardened (`unsafe-eval` removed in production, only in dev)
- XSS protection: quotes escaped in markdown link URLs
- Rate limiting on auth endpoints (DB-backed, not in-memory)
- `/admin` protected in middleware
- Middleware protects: /dashboard, /projects, /alerts, /chat, /integrations, /settings, /admin, /recordings
- API routes handle their own auth (allows public webhooks)
- MCP OAuth: CSRF protection via HTTP-only cookie + token validation
- Encryption: API keys encrypted at rest via ENCRYPTION_KEY

## Chaos engineering & stress testing

### Chaos tests (Vitest) — `web/lib/chaos/`

103 fault injection tests across 4 levels. Run: `cd web && npx vitest run lib/chaos/`

| Level | Tests | What it validates |
|-------|-------|-------------------|
| **L1 — Unit** (5 files) | 29 | AI provider timeout/retry, notification silent failures, dedup race conditions, cron overlap, SSE memory leaks |
| **L2 — Integration** (4 files) | 28 | Alert storm lifecycle, escalation without on-call, auto-heal cascade + cooldown, remediation under GitHub API failure |
| **L3 — Security** (4 files) | 106 | SSRF bypass vectors (46 payloads), X-Forwarded-For spoofing, webhook signature edge cases, XSS injection (14 payloads across Slack/Telegram/JSX) |

Key files:
- `web/lib/chaos/faults.ts` — `withFaultyFetch()` patches globalThis.fetch with faults by URL pattern
- `web/lib/chaos/harness.ts` — `chaosTest()` captures console output + timing
- `web/lib/chaos/__tests__/helpers/mock-db.ts` — shared DB mock factory for integration tests

### Stress tests (k6) — `k6/scenarios/`

14-scenario k6 suite (10 load + 4 chaos). Run: `bash k6/run-all.sh` (requires k6 + `k6/.env`)

| # | Scenario | What it validates |
|---|----------|-------------------|
| 1 | `webhook-storm` | Capture webhook ingestion under burst load, rate limiting |
| 2 | `mcp-rate-limits` | 3 MCP rate limit tiers (cheap/moderate/expensive) |
| 3 | `sse-streaming` | 50 concurrent SSE connections, reconnection |
| 4 | `alert-dedup` | Fingerprinting, dedup accuracy, storm detection |
| 5 | `auth-bruteforce` | Login brute force protection, device flow rate limits |
| 6 | `cron-fanout` | 7 sub-pollers in parallel, overlap handling |
| 7 | `neon-saturation` | DB concurrency: webhooks + MCP + cron simultaneously |
| 8 | `push-serialization` | Push notification pipeline under burst |
| 9 | `auto-heal` | 3 failures → auto-heal, cooldown, race conditions |
| 10 | `full-incident` | Complete incident lifecycle end-to-end |
| 11 | `chaos-incident` | Full incident with mixed valid/malformed payloads + concurrent cron + storm |
| 12 | `chaos-mcp-storm` | 200 concurrent MCP calls mixing all 3 rate limit tiers |
| 13 | `chaos-tenant-isolation` | Flood one workspace, verify another's latency stays normal |
| 14 | `chaos-sse` | 50+ SSE connections with random abrupt disconnects |

## Demo recording

```bash
DEMO_URL=https://app.inariwatch.com DEMO_EMAIL=demo@inariwatch.com DEMO_PASSWORD=Demo1234! npx tsx scripts/record-demo.ts
```

Outputs `.webm` to `scripts/demo-output/`. Convert to GIF:
```bash
# Run convert.bat (saved at %TEMP%/convert.bat) in PowerShell
& "$env:TEMP\convert.bat"
```

## InariWatch Agent (`orbita-pos/inariwatch-agent`)

Kernel-level observability agent. Installed on the user's server with `curl -sf https://install.inariwatch.com | sh`. Zero code changes, language-agnostic (Node.js, Python, Go, Java, anything).

**Stack (confirmed by Datadog, Cilium, Cloudflare, Falco, Pixie):**

| Layer | Technology | Why |
|---|---|---|
| Kernel (eBPF) | **C** | BPF verifier designed for C. CO-RE, BTF, libbpf ecosystem. ~10 files, 50-120 lines each |
| Userspace | **Rust** | Memory safety, static binary (musl), async with tokio. 95% of the code |
| Bridge | **libbpf-rs v0.26 + libbpf-cargo v0.26** | CO-RE complete, skeleton generation, stable Rust. Meta uses in production |
| Symbolization | **blazesym v0.2** | Meta uses at billions of requests/day |
| Async ring buffer | **libbpf-async** | Tokio integration without blocking epoll_wait |

**NOT Aya** — CO-RE incomplete (rustc doesn't emit required LLVM intrinsics), requires nightly, fewer program types.

**Project structure:**
```
inariwatch-agent/          # ~50 files
├── bpf/                   # C BPF programs
│   ├── include/           # common.h, maps.h, events.h (shared C ↔ Rust)
│   ├── process.bpf.c     # exec/exit/fork tracepoints
│   ├── network.bpf.c     # TCP state, retransmit, sendmsg/recvmsg
│   ├── filesystem.bpf.c  # vfs_open/write/unlink kprobes
│   ├── dns.bpf.c         # UDP:53 raw capture (parsing in Rust, NOT kernel)
│   ├── tls.bpf.c         # SSL_read/SSL_write uprobes
│   ├── syscall.bpf.c     # raw_tracepoint dispatcher
│   └── security.bpf.c    # LSM hooks (needs BPF LSM enabled in kernel)
├── crates/
│   ├── agent/             # Main binary, probe loader, TLS discovery, auto-updater
│   ├── events/            # Event types, ring buffer consumer, batch accumulator, DNS parser
│   ├── transport/         # HTTP client (reqwest), disk-backed overflow buffer
│   └── common/            # Config (TOML + CLI + env), constants
├── scripts/install.sh     # One-line installer (curl | sh)
├── dist/                  # systemd service, default config template
└── .github/workflows/     # CI/CD: cross-compile x86_64 + aarch64, GitHub Releases
```

**Probes status (tested on Hetzner, kernel 6.8.0):**

| Probe | Status | Hook type |
|---|---|---|
| Process | **Active** | tracepoint/sched/sched_process_exec, exit, fork |
| Network | **Active** | tracepoint/sock/inet_sock_set_state, kprobe/tcp_sendmsg |
| Filesystem | **Active** | kprobe/vfs_open, vfs_write, vfs_unlink |
| DNS | **Active** | kprobe/udp_sendmsg (raw capture, parsed in Rust) |
| Syscall | **Active** | raw_tracepoint/sys_enter |
| TLS | **Active** | uprobe on SSL_read/SSL_write (auto-discovery finds libssl.so.3 + Go crypto/tls) |
| Security | **Active** | LSM hooks (BPF LSM enabled in kernel GRUB config) |

**Key design decisions:**
- DNS: raw capture in kernel (40 lines C), full RFC 1035 parsing in Rust (444 lines). Same pattern as Datadog/Coroot — NEVER parse DNS in kernel (verifier rejects complex loops)
- TLS interception: scans `/proc/PID/maps` every 30s for libssl.so, attaches uprobes dynamically via goblin ELF parsing
- Event pipeline: BPF ring buffer → crossbeam channel → tokio workers → batch (1000 events / 256KB / 5s) → LZ4 compress → HTTPS
- CO-RE: single static binary for all kernels 5.8+ (no clang/headers needed on target)
- Graceful degradation: if a probe fails to load, skip it and continue (only process probe is fatal — provides shared maps)
- Performance: 248 events/sec observed, ~88% LZ4 compression, <1% CPU budget

**Cloud endpoint (InariWatch web):**
- Route: `POST /api/agent/events` (`web/app/api/agent/events/route.ts`)
- Auth: Bearer token (HMAC-SHA256 of agent_id with integration webhook secret)
- Processing: `web/lib/agent/processor.ts` — threat detection (SQL injection, XSS, SSRF, command injection, reverse shells, web shells, container escape, sensitive file access, malicious DNS)
- Alerts: uses existing `createAlertIfNew()` pipeline (dedup, fingerprint, notifications, auto-remediation)

**Build on Hetzner:**
```bash
cd /opt/inariwatch-agent
git pull
cargo build                # debug (fast, ~4GB RAM ok)
cargo build --release --target x86_64-unknown-linux-musl  # release (needs more RAM, use CI)
sudo ./target/debug/inariwatch-agent --log-level debug
```

**Dependencies installed on Hetzner:** clang-18, llvm-18, libelf-dev, libbpf-dev, musl-tools, Rust 1.94.1

**Hetzner kernel config:** BPF LSM enabled via GRUB (`lsm=lockdown,capability,landlock,yama,apparmor,bpf`)

**Run command (all 7 probes):**
```bash
sudo ./target/debug/inariwatch-agent --log-level debug --enable-tls true --enable-security true
```

**TODO:**
- Connect to InariWatch cloud (configure DSN, integration ID, webhook secret)
- Install as systemd service for persistent operation
- Release binary via GitHub Actions CI/CD

## Developer context

- **Owner:** Jesus Bernal (@JesusBrDev) — solo founder, Mexico
- **Languages used across projects:** Rust, Go, TypeScript
- **Style:** Keep it simple, no over-engineering, no unnecessary abstractions
- **Avoid:** Mocks in tests, unsafe-eval in CSP, in-memory rate limiters on serverless

## CLI vs Web: Intentional Differences

These differences are by design — do not attempt to "fix" them.

| Area | CLI | Web | Why |
|------|-----|-----|-----|
| **Default AI model** | `claude-haiku-4-5-20251001` (fast, cheap) | GPT-4o-mini for analysis, GPT-5.4 for remediation | CLI runs locally, cost-sensitive; Web uses platform key (OpenAI), optional BYOK for other providers |
| **Auto-merge gates** | 4 gates + trust levels | 11 gates (includes substrate, EAP, prediction, security scan, e2e) | Gates 5-11 require server-side infrastructure not available in CLI |
| **Diagnosis context** | Sentry, Vercel, GitHub CI | Same + Datadog, Substrate, Deploy, Codebase RAG, Past Fixes | Extra sources are web-only integrations |
| **Security scan** | Blocked file patterns only | ESLint + 19 regex patterns + AI review | eslint-plugin-security runs serverless, not portable to Rust |
| **Dedup window** | Infinite (watch), 60s (dev) | 24h sliding window | CLI uses local SQLite (persistent); Web handles async multi-source ingestion |
| **Auto-analyze on arrival** | Not implemented — CLI goes straight to remediation | `buildAnalyzePrompt` → plain text, 200 words, stored in `aiReasoning` | Web-only feature: quick AI triage for dashboard/Slack/Telegram display |
| **Post-merge monitor** | Delegates to background task | Inline (Sentry + Uptime + Fingerprint checks) | Web has direct DB access for regression checks |
| **Escalation triggers** | 3 (low confidence, CI fail, regression) | 5+ (same + self-review reject, Vercel-without-Sentry) | Web has more integration context to make nuanced decisions |
| **Notification format** | Raw client, caller handles format | Rich formatter in `lib/telegram/format.ts` | CLI keeps Telegram client minimal; escalation.rs handles its own formatting |
| **Community patterns auth** | `api_token` in config.toml | Session auth or `CRON_SECRET` Bearer | CLI uses Bearer token matching web's CRON_SECRET |
| **MCP AI strategy** | N/A (CLI has no MCP client) | Sampling-first for analysis (4 tools), platform-funded for remediation (trigger_fix) | MCP clients already have an LLM — no need for server-side AI calls for analysis |
