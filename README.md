<div align="center">

<img src="web/public/marketing2.png" alt="InariWatch — You Sleep. We Ship." width="100%" />

<br />

<img src="web/public/demo.gif" alt="InariWatch demo" width="100%" />

<br />

# InariWatch

**The monitoring platform that fixes itself.**

AI detects your incidents, analyzes the root cause, and opens a PR with the fix — while you sleep.

<br />

[![License: MIT](https://img.shields.io/badge/License-MIT-7C3AED.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/orbita-pos/inariwatch?style=flat&color=7C3AED)](https://github.com/orbita-pos/inariwatch/stargazers)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/orbita-pos/inariwatch)

[Live Demo](https://inariwatch.com) · [Docs](https://inariwatch.com/docs) · [Discord](#) · [Twitter/X](#)

</div>

---

## The problem

Every monitoring tool wakes you up at 3am. Then you fix it yourself. Then you go back to sleep.

InariWatch breaks that loop. It monitors everything that matters, and when something breaks, it doesn't just notify you — **it fixes it**.

---

## What it does

```
Your infra breaks at 3am
        ↓
InariWatch detects it (uptime, GitHub, Sentry, Vercel, DB...)
        ↓
AI analyzes the root cause
        ↓
AI opens a PR with the fix
        ↓
You wake up to a green build
```

---

## Features

### 🔍 Monitor everything
- **Uptime** — HTTP/HTTPS endpoints with configurable intervals
- **GitHub** — failing CI, open vulnerabilities, dependency alerts, PR health
- **Sentry** — new issues, error spike detection, regression alerts
- **Vercel** — failed deployments, build errors
- **PostgreSQL** — connection health, query performance
- **npm** — security audit on your packages
- **Datadog** — forward any monitor alert

### 🤖 AI that actually works
- **Root cause analysis** — understands what broke and why
- **Auto-remediation** — opens a PR with the fix (GitHub Copilot-style, but for incidents)
- **Post-mortems** — generates a report automatically
- **Ask Inari** — chat with AI about your alerts and codebase

### 🚨 Smart alerting
- Incident storm detection — suppresses spam during outages
- Severity levels (critical / warning / info) with per-channel filters
- **On-call scheduling** — rotations, time slots, overrides
- **Multi-level escalation** — Primary → Secondary → All org admins
- Email digests — one email per 5 minutes, not one per alert

### 📣 Notifications everywhere
- **Telegram** — with inline ACK/Resolve buttons
- **Slack** — with Block Kit ACK/Resolve buttons
- **Email** — with tracking and unsubscribe
- **Push notifications** — browser push via VAPID
- **Outgoing webhooks** — POST to any endpoint

### 🌐 Status pages
- Public status page at `/status/[your-project]`
- 90-day uptime history per monitor
- Automatic incident timeline

### 🔒 Security-first
- AES-256-GCM encryption for all stored secrets (key versioning)
- Time-bound HMAC signatures on action links (72h expiry)
- HMAC webhook verification (GitHub, Sentry, Vercel)
- SSRF protection on all user-provided URLs
- 2FA support

---

## Self-host in 5 minutes

### Deploy to Vercel (recommended)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/orbita-pos/inariwatch)

### Docker

```bash
git clone https://github.com/orbita-pos/inariwatch
cd inariwatch/web
cp .env.example .env.local
# Edit .env.local with your values
docker compose up
```

### Manual

```bash
git clone https://github.com/orbita-pos/inariwatch
cd inariwatch/web
npm install
cp .env.example .env.local
npm run db:push
npm run dev
```

---

## Environment variables

```env
# Database (Neon, Supabase, or any Postgres)
DATABASE_URL=postgresql://...

# Auth
NEXTAUTH_URL=https://your-domain.com
NEXTAUTH_SECRET=your-secret-here

# Encryption (generate with: openssl rand -hex 32)
ENCRYPTION_KEY=your-32-byte-hex-key

# Email (Resend)
RESEND_API_KEY=re_...

# Optional: AI providers (BYOK)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Push notifications
NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...

# Optional: Cron auth (for Vercel cron jobs)
CRON_SECRET=your-cron-secret
```

---

## CLI

InariWatch also ships a local CLI for developers who want monitoring without the cloud:

```bash
npm install -g @inariwatch/cli
inari init
inari watch
```

The CLI is fully open source and works 100% offline. [→ CLI docs](cli/README.md)

---

## Architecture

```
inariwatch/
├── cli/          # Local CLI (TypeScript, fully offline)
└── web/          # Cloud platform (Next.js 15, Drizzle, Neon)
    ├── app/
    │   ├── (dashboard)/  # Main app UI
    │   ├── (marketing)/  # Landing page, docs
    │   ├── api/
    │   │   ├── cron/     # Polling jobs (poll, escalate, uptime, digest)
    │   │   └── webhooks/ # Incoming webhooks (GitHub, Sentry, Vercel, Datadog)
    │   └── status/       # Public status pages
    └── lib/
        ├── notifications/ # Telegram, Slack, Email, Push
        ├── pollers/       # Per-integration polling logic
        └── webhooks/      # HMAC verification, shared utils
```

---

## Roadmap

- [ ] Mobile app (iOS / Android)
- [ ] More integrations: AWS CloudWatch, GCP, Render, Railway
- [ ] Runbooks — AI-generated step-by-step resolution guides
- [ ] Incident channels — dedicated Slack/Teams channel per incident
- [ ] SLA tracking
- [ ] Audit log export (CSV/JSON)

---

## Contributing

InariWatch is MIT licensed and we love contributions.

```bash
git clone https://github.com/orbita-pos/inariwatch
cd inariwatch/web
npm install
npm run dev
```

**Good first issues:** look for `good first issue` label on GitHub.

For larger changes, open a discussion first so we can align on approach.

---

## License

MIT — free to use, self-host, modify, and distribute. See [LICENSE](LICENSE).

---

<div align="center">

Built with ❤️ and pixel foxes.

**[inariwatch.com](https://inariwatch.com)** · **[Star on GitHub ⭐](https://github.com/orbita-pos/inariwatch)**

</div>
