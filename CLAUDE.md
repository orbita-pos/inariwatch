# Radar — CLAUDE.md

Radar is a proactive developer monitoring platform. It polls GitHub, Vercel, and Sentry every 5 minutes and surfaces alerts in a web dashboard, desktop app, and (optionally) Telegram. There is also a local Rust CLI that runs entirely on the user's machine.

---

## Project layout

```
radar/
├── web/        → Next.js 15 web dashboard (primary product)
├── cli/        → Rust CLI (local/standalone mode, BYOK AI)
├── desktop/    → Tauri 2 desktop app (system tray wrapper)
└── CLAUDE.md   → this file
```

---

## Web (`web/`)

### Stack

- **Next.js 15** (App Router, React 19, TypeScript)
- **Drizzle ORM** + **Neon** (PostgreSQL serverless)
- **NextAuth v4** — GitHub OAuth + credentials (email/password)
- **Tailwind CSS** v3, custom dark theme
- **Radix UI** for headless components
- **Vercel** for hosting + cron jobs

### Running locally

```bash
cd web
npm install
cp .env.example .env.local   # fill in DATABASE_URL, NEXTAUTH_SECRET, GITHUB_CLIENT_ID/SECRET
npm run dev                  # http://localhost:3000
```

### Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `NEXTAUTH_SECRET` | Random secret (`openssl rand -base64 32`) |
| `NEXTAUTH_URL` | `http://localhost:3000` in dev, production URL in prod |
| `GITHUB_CLIENT_ID` | OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | OAuth app client secret |
| `CRON_SECRET` | Bearer token that protects `/api/cron/poll` |

### Database (Drizzle)

Schema is at `web/lib/db/schema.ts`. Migrations live in `web/lib/db/migrations/`.

```bash
cd web
npx drizzle-kit generate   # generate migration from schema changes
npx drizzle-kit migrate    # apply migrations to Neon
```

**Tables:**

| Table | Purpose |
|---|---|
| `users` | Auth + plan (free/pro/team) |
| `accounts` | NextAuth OAuth accounts |
| `projects` | User's monitoring projects (name, slug) |
| `project_integrations` | Connected services per project — stores tokens + alert config in `config_encrypted` JSONB |
| `alerts` | Generated alerts (severity, title, body, sourceIntegrations, isRead, isResolved) |
| `notification_channels` | Telegram/email/Slack endpoints per user |
| `notification_logs` | Delivery audit trail |
| `api_keys` | Desktop app token (`service = "desktop"`) and other keys |

**Key type:** `configEncrypted` JSONB in `project_integrations` stores:
```json
{
  "token": "...",
  "owner": "github-username",
  "teamId": "vercel-team-id",
  "org": "sentry-org-slug",
  "alertConfig": {
    "failed_ci":      { "enabled": true },
    "stale_pr":       { "enabled": true, "days": 3 },
    "unreviewed_pr":  { "enabled": true, "hours": 24 },
    "failed_production": { "enabled": true },
    "failed_preview":    { "enabled": false },
    "new_issues":     { "enabled": true },
    "regressions":    { "enabled": true }
  }
}
```

### App Router structure

```
web/app/
├── (marketing)/          → Public landing page
├── (auth)/login/         → NextAuth login
├── (dashboard)/          → Protected (requires session)
│   ├── layout.tsx        → Sidebar + top nav shell
│   ├── dashboard/        → Overview — recent alerts, project stats
│   ├── alerts/           → Alert list (all user projects, last 50)
│   ├── alerts/[id]/      → Alert detail — mark read/resolved, body, metadata
│   ├── integrations/     → Connect GitHub/Vercel/Sentry, configure alert types
│   ├── projects/         → Create / list projects
│   └── settings/         → Account info, notification channels, API keys, desktop token
└── api/
    ├── auth/[...nextauth]/  → NextAuth handler
    ├── cron/poll/           → Vercel Cron endpoint (GET, every 5 min)
    └── desktop/alerts/      → Desktop app polling (Bearer token auth)
```

Every dashboard page has a matching `loading.tsx` skeleton for Suspense.

### Alert polling system

**Vercel Cron** fires `GET /api/cron/poll` every 5 minutes. It:
1. Fetches all `isActive = true` integrations from DB
2. Calls the right poller (`lib/pollers/github.ts`, `vercel-api.ts`, `sentry.ts`)
3. Deduplicates: skips if an open, unresolved alert with the same title exists in the last 24h
4. Inserts new alerts, updates `lastCheckedAt` / `errorCount`

**Pollers** (`web/lib/pollers/`):
- `github.ts` — failed CI checks, stale PRs (configurable days), unreviewed PRs (configurable hours)
- `vercel-api.ts` — failed production deploys (critical), failed preview deploys (warning, off by default)
- `sentry.ts` — new issues and regressions in the last 10 minutes

**Important:** The cron runs on **your** Vercel infrastructure, not the user's. Vercel Hobby plan only allows daily crons — Pro plan or above is needed for every-5-minutes cadence.

### Integration connect flow

1. User clicks "Connect GitHub" → `ConnectModal` opens
2. User pastes token → `connectIntegration` server action
3. Server calls service API to validate token and auto-detect `owner`/`teamId`/`org`
4. Stored in `configEncrypted` JSONB
5. User clicks "configure" on a connected row → `ConfigModal` opens
6. Toggles + threshold inputs → `saveAlertConfig` merges `alertConfig` into existing JSONB

### Auth

- NextAuth JWT strategy (stateless, no DB sessions)
- GitHub OAuth + email/password credentials
- On first OAuth sign-in: upserts user into `users` table, stores our UUID in JWT
- `session.user.id` is our UUID from the `users` table (not the OAuth ID)

### Tailwind theme

Custom colors defined in `tailwind.config.ts`:
- `radar-red` → `#e63946` (primary accent, alerts, danger)
- `radar-bg` → `#09090b`
- `radar-card` → `#0d0d10`
- `radar-border` → `#1e1e22`
- `radar-red-dim` → `rgba(230,57,70,0.08)`

---

## CLI (`cli/`)

Local Rust CLI — runs entirely on the user's machine. No server required.

### Stack

- **Rust 2021**, clap, tokio, reqwest, serde, rusqlite (bundled), dirs, colored, dialoguer, anyhow

### Running

```bash
cd cli
cargo build --release
./target/release/radar --help
```

### Commands

| Command | Purpose |
|---|---|
| `radar init` | Create new project (interactive) |
| `radar add github` | Add GitHub integration (prompts for token + owner + repos) |
| `radar add vercel` | Add Vercel integration |
| `radar add sentry` | Add Sentry integration |
| `radar add git` | Add local git integration |
| `radar connect telegram` | Connect Telegram notifications |
| `radar watch` | Main loop — polls every 60s, correlates with AI, sends Telegram alerts |
| `radar status` | Show integration health |
| `radar logs` | Show recent alerts from local DB |
| `radar config --ai-key <key>` | Set Claude/OpenAI API key |

### Storage

- Config: `~/.config/radar/config.toml` — AI key, model, per-project integrations
- Database: `~/.local/share/radar/radar.db` — SQLite, `events` and `alerts` tables

### AI correlation

If an AI key is configured (Claude `sk-ant-` or OpenAI `sk-`), the `watch` command groups events within a 30-minute window and calls the AI to correlate them into a single, actionable alert. Without a key, raw events are stored only.

---

## Desktop (`desktop/`)

Tauri 2 native app — wraps the web dashboard in a WebView with system tray.

### Stack

- **Tauri 2**, `tauri-plugin-notification`, `tauri-plugin-autostart`
- Rust backend, no frontend framework (loads production URL)

### Running

```bash
cd desktop
npm install
npm run tauri dev    # opens webview → http://localhost:3000 (needs web running locally)
npm run tauri build  # produces installers in src-tauri/target/release/bundle/
```

### Features

- System tray (◉ icon) — left-click toggles show/hide window
- Tray right-click menu: Open Radar / Quit
- Close button → hides to tray (does not quit)
- Background poller every 60s: reads `~/.config/radar/desktop.toml` (`api_url`, `api_token`), calls `/api/desktop/alerts` with Bearer token, shows OS notifications for new alerts

### Desktop token flow

1. User goes to Settings → Desktop app → clicks "Generate token"
2. Token is created (`rdr_...`) and stored in `api_keys` with `service = "desktop"`
3. User copies token into `~/.config/radar/desktop.toml`
4. Desktop app reads the file and polls `/api/desktop/alerts`

---

## Key conventions

- **Server actions** live in `actions.ts` colocated with the page that uses them
- **Always verify ownership** before any DB mutation: look up the resource, then check `userId` via the project chain
- **No `max-w-*` on dashboard pages** — content uses full width. Exception: `settings` (`max-w-[680px]`) and `alerts/[id]` (`max-w-[780px]`) for readability
- **Loading skeletons** — every dashboard page has a `loading.tsx` that mirrors the page layout
- **Alert deduplication** — before inserting, always check for an open unresolved alert with the same title in the last 24h for the same project
- **Context-aware empty states** — check `projectIntegrations` before showing "connect an integration" vs. "Radar is watching your integrations"
- **No CLI language in web UI** — don't reference `radar watch`, `$ radar ...` commands on dashboard pages. Those are CLI-only concepts

---

## What's not built yet

- Stripe billing (plan upgrades wired to Vercel → webhook → update `users.plan`)
- Notification delivery for web users (send Telegram/email when alert is created via cron)
- Push notifications in the browser (service worker)
- Alert badge count in sidebar (real-time unread count)
- `postgres` and `npm/cargo` integrations (shown as "coming soon")
