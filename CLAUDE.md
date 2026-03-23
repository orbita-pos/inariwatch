# InariWatch — CLAUDE.md

## Project overview

InariWatch is an AI-powered monitoring SaaS for developers. It receives alerts from external services (Sentry, Vercel, GitHub, Datadog), enriches them with AI analysis, and helps teams respond faster with on-call scheduling and automated remediation suggestions.

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
│   │   ├── api/          # API routes: webhooks, cron, stripe, auth, chat, notifications
│   │   ├── invite/       # Workspace invite flow
│   │   └── status/       # Public status page
│   ├── lib/
│   │   ├── ai/           # AI layer: correlate, remediate, auto-analyze, postmortem, risk assessment
│   │   ├── db/           # Drizzle ORM schema + migrations (Neon PostgreSQL)
│   │   ├── auth/         # NextAuth config and helpers
│   │   ├── pollers/      # Sentry, Vercel polling logic
│   │   ├── services/     # External API clients (Vercel, GitHub, Sentry, Datadog)
│   │   ├── notifications/ # Email, push notifications
│   │   └── webhooks/     # Webhook ingestion logic
│   └── scripts/          # Demo recorder (Playwright), seed-demo
└── cli/          # Rust CLI (local monitoring mode — separate product)
```

## Stack

- **Framework:** Next.js 15 (App Router), TypeScript
- **Database:** PostgreSQL via Neon + Drizzle ORM
- **Auth:** NextAuth (credentials + Google)
- **AI:** Multi-provider BYOK — Claude, OpenAI, Gemini, Mistral, Grok (5 providers)
- **Payments:** Stripe (subscriptions + promotion codes)
- **Deploy:** Vercel
- **Email:** Resend
- **Push notifications:** Web Push API
- **Rate limiting:** DB-backed atomic UPSERT (safe across serverless instances)
- **Cron:** cron-job.org (external, not Vercel crons)

## Key features

- **Alerts** — ingest from Sentry, Vercel, GitHub, Datadog via webhooks; AI auto-analysis on arrival
- **Ask Inari** — chat interface for querying alert history and getting AI recommendations
- **On-call scheduling** — rotation schedules per project, escalation policies
- **Auto-merge gates** — AI risk assessment before merging PRs
- **AI remediation** — suggested fixes per alert, post-mortems
- **Analytics** — alert trends, MTTR, severity breakdowns
- **Blog** — markdown-based, admin editor, newsletter subscriptions
- **Workspaces** — multi-tenant, invite system, role-based access
- **Admin panel** — internal user/workspace management

## Database migrations

Migrations live in `web/lib/db/migrations/`. Run them with Drizzle Kit. Current: `0009_rate_limits.sql`.

## Environment variables

See `web/.env.example` — fully documented. Key vars:
- `DATABASE_URL` — Neon PostgreSQL connection string
- `NEXTAUTH_SECRET`, `NEXTAUTH_URL`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `ADMIN_EMAIL` — grants access to `/admin`
- `APP_URL` — used for cron fan-out (fallback: `VERCEL_URL`)

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
