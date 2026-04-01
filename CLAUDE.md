# InariWatch — CLAUDE.md

## Project overview

InariWatch is an AI-powered monitoring SaaS for developers. It receives alerts from external services (Sentry, Vercel, GitHub, Datadog) and from your own app via `@inariwatch/capture`, enriches them with AI analysis, and helps teams respond faster with on-call scheduling, automated remediation, and local dev-mode fixes.

The product is live at **app.inariwatch.com**. There is also a demo account at `demo@inariwatch.com`.

## Repo structure

```
/
├── web/          # Next.js 15 app — the main product
│   ├── app/
│   │   ├── (auth)/       # Login, register, forgot-password, reset-password
│   │   ├── (dashboard)/  # Authenticated app: alerts, projects, on-call, analytics, chat, settings, admin
│   │   ├── (marketing)/  # Landing page, blog, docs, pricing
│   │   ├── admin/        # Internal admin panel
│   │   ├── api/          # API routes: webhooks, cron, stripe, auth, chat, notifications, slack
│   │   ├── invite/       # Workspace invite flow
│   │   └── status/       # Public status page
│   │   └── api/mcp/      # Hosted MCP server (17 tools, 4 resources, 5 prompts)
│   ├── lib/
│   │   ├── ai/           # AI layer: correlate, remediate, auto-analyze, postmortem, risk assessment, community-fix-lookup
│   │   ├── db/           # Drizzle ORM schema + migrations (Neon PostgreSQL)
│   │   ├── services/     # Service layer — SSOT for all business logic (alerts, diagnosis, vercel, chat)
│   │   ├── auth/         # NextAuth config and helpers
│   │   ├── slack/        # Slack bot: client, blocks, send, actions, verify, remediation-bridge
│   │   ├── pollers/      # Sentry, Vercel polling logic
│   │   ├── notifications/ # Email, push, Telegram, Slack webhooks
│   │   └── webhooks/     # Webhook ingestion logic
│   └── scripts/          # Demo recorder (Playwright), seed-demo
├── mcp/          # @inariwatch/mcp — npx init tool (auto-detect AI tools, install capture, configure MCP)
├── capture/      # @inariwatch/capture — npm SDK (zero deps, zero config)
├── vscode/       # VS Code extension — inline diagnostics, AI hover, sidebar
├── action/       # GitHub Action — AI risk assessment on PRs
└── cli/          # Rust CLI (local monitoring: dev, watch, simulate — serve-mcp deprecated)
```

## Stack

- **Framework:** Next.js 15 (App Router), TypeScript
- **Database:** PostgreSQL via Neon + Drizzle ORM
- **Auth:** NextAuth (credentials + Google)
- **AI:** Multi-provider BYOK — Claude, OpenAI, Gemini, DeepSeek, Grok (5 providers)
- **Deploy:** Vercel
- **Email:** Resend
- **Push notifications:** Web Push API
- **Slack:** @slack/web-api (OAuth bot, not just webhooks)
- **Rate limiting:** DB-backed atomic UPSERT (safe across serverless instances)
- **Cron:** cron-job.org (external, not Vercel crons)
- **Substrate:** Optional I/O recording via @inariwatch/substrate-agent (ring buffer, auto-flush on error)
- **Cortex:** External execution data plane — serves EAP verification chain (optional, via EAP_SERVER_URL)
- **EAP:** Cryptographic proof chain for AI fix verification (Merkle trees, Ed25519)

## Key features

- **Alerts** — ingest from Sentry, Vercel, GitHub, Datadog, @inariwatch/capture via webhooks; free AI auto-analysis on arrival (GPT-4o-mini, no key required)
- **Ask Inari** — chat interface for querying alert history and getting AI recommendations (BYOK)
- **On-call scheduling** — rotation schedules per project, escalation policies, schedule overrides
- **Auto-merge gates** — 8 safety gates: auto_merge_enabled, CI pass, confidence (>= threshold), lines changed (<= max), self-review (>= 70), substrate_simulate (risk <= 40), eap_chain_verified, post-merge monitor
- **AI remediation** — full pipeline: diagnose → read code → generate fix → self-review → push → CI (3x retry) → PR → optional auto-merge; live terminal UI in dashboard
- **Autonomous mode** — `autoRemediate: true` auto-triggers remediation on critical alerts without human click; all 8 safety gates still apply
- **Auto-heal** — `autoHeal: true` when uptime detects site down (3 consecutive failures): rollback to last good Vercel deploy + start AI remediation; 10-min cooldown prevents loops
- **Community fix network** — crowdsourced error fixes with success rates; when an error matches a known pattern, shows "47 teams fixed this, 96% success rate" with one-click apply
- **Slack bot** — full control surface: alert delivery with AI diagnosis, [Fix It] button triggers remediation in-thread, slash commands (status, alerts, fix, oncall, link, help), Ask Inari AI chat via @mention, deploy monitoring with 15-min health check, incident storm threads with postmortem generation
- **VS Code extension** — inline diagnostics (squiggly lines from stack traces), AI diagnosis on hover, sidebar alert list grouped by file, status bar unread count, local mode (port 9222, no cloud needed)
- **Capture SDK** — `@inariwatch/capture` on npm, zero deps, zero config; `npx @inariwatch/capture` auto-detects framework; env var driven (INARIWATCH_DSN); `/auto` import, `/next` plugin; optional Substrate I/O recording with `substrate: true`
- **Dev mode** — `inariwatch dev` catches local errors, diagnoses with AI, applies fixes directly to disk
- **GitHub Action** — AI risk assessment posted on every PR as a comment
- **Analytics** — alert trends, MTTR, severity breakdowns
- **Blog** — markdown-based, admin editor, newsletter subscriptions
- **Workspaces** — multi-tenant, invite system, role-based access
- **Admin panel** — internal user/workspace management

## Service layer — single source of truth

All business logic lives in `web/lib/services/`. Every surface (MCP, Slack, dashboard, extension, cron) calls these services instead of reimplementing queries.

| Service | File | Functions |
|---|---|---|
| Alerts | `lib/services/alerts.service.ts` | queryAlerts, getAlert, silenceAlert, acknowledgeAlert, reopenAlert, getAlertStats, getErrorTrends |
| Diagnosis | `lib/services/diagnosis.service.ts` | diagnoseAlert (uses `lib/ai/prompts.ts` as prompt SSOT) |
| Vercel | `lib/services/vercel.service.ts` | getRecentDeployments, rollbackToDeployment, getBuildLogs |
| Chat | `lib/services/chat.service.ts` | gatherChatContext, buildContextString, SYSTEM_OPS |
| URL validation | `lib/services/url-validation.ts` | isSafeUrl (SSRF protection) |

**Rules:**
- Services receive typed params, return typed data — no HTTP/MCP/Slack protocol objects
- Services handle their own DB queries — consumers don't touch Drizzle directly for covered operations
- When adding a new operation, add it to the service first, then wire it to each surface

**Surfaces that consume services:**
- MCP web tools (`web/app/api/mcp/tools/*.ts`) — 17 tools
- Slack bot (`web/lib/slack/actions.ts`) — acknowledgeAlertCore, resolveAlertCore
- Dashboard (`web/app/(dashboard)/alerts/[id]/ai-actions.ts`)
- Extension endpoints (`web/app/api/extension/`) — DEPRECATED, migrating to MCP

**Not yet extracted (acceptable — no duplication):**
- Remediation: all surfaces already call `runRemediation()` from `lib/ai/remediate.ts`
- On-call: centralized in `lib/on-call.ts`
- Risk assessment: `lib/ai/risk-assessment.ts` (MCP has a simpler version, intentional)

## MCP server

Hosted at `mcp.inariwatch.com` (Vercel rewrite → `POST /api/mcp`). Streamable HTTP, JSON-RPC 2.0.

- **17 tools** — query_alerts, get_status, get_uptime, get_build_logs, get_substrate_context, get_root_cause, assess_risk, get_postmortem, search_community_fixes, trigger_fix, rollback_vercel, silence_alert, submit_feedback, run_check, ask_inari, get_error_trends, create_uptime_monitor
- **4 resources** — alerts/critical, alerts/recent, status/overview, remediations/active
- **5 prompts** — diagnose, status-report, fix-this, post-deploy-check, weekly-summary
- **Auth:** Bearer tokens (SHA-256 hashed), OAuth 2.1 + PKCE, granular scopes (read/write/execute)
- **Rate limits:** cheap (200/min), moderate (30/min), expensive (5/min) per tool
- **Audit trail:** every tool call logged to audit_logs
- **Setup:** `npx @inariwatch/mcp init` (detects AI tools, installs capture, configures MCP, links GitHub, enables Substrate)

CLI Rust `serve-mcp` is deprecated — web MCP is the source of truth. CLI keeps: init, add, connect, config, dev, watch, simulate.

## Database migrations

Migrations live in `web/lib/db/migrations/`. Run them with Drizzle Kit. Current: `0024_mcp_token_hash.sql`.

## Environment variables

See `web/.env.example` — fully documented. Key vars:
- `DATABASE_URL` — Neon PostgreSQL connection string
- `NEXTAUTH_SECRET`, `NEXTAUTH_URL`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `ADMIN_EMAIL` — grants access to `/admin`
- `APP_URL` — used for cron fan-out (fallback: `VERCEL_URL`)
- `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` — Slack bot OAuth
- `EAP_SERVER_URL` — optional, points to Cortex server for cryptographic verification

## Security considerations

- CSP hardened (`unsafe-eval` removed in production)
- XSS protection: quotes escaped in markdown link URLs
- Rate limiting on auth endpoints (DB-backed, not in-memory)
- `/admin` protected in middleware

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
