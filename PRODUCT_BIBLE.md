# InariWatch — Product Bible

> Last updated: April 12, 2026
> Founder & CEO: Jesus Bernal (@JesusBrDev) — Mexico

---

# Layer 1 — The Story

*For anyone: investors, press, non-technical audiences, elevator pitches.*

---

## The Problem

Every developer knows the 3am page. Something broke in production. You open your laptop, squint at a stack trace, dig through logs, find the bug, write a fix, push it, wait for CI, merge, deploy, and pray it doesn't break something else.

This cycle — detect, diagnose, fix, test, deploy, monitor — takes hours. Sometimes days. And 70% of engineering time is spent on maintenance, not building new things.

The tools we have today are fragmented. Sentry tells you *something broke*. PagerDuty tells you *to wake up*. GitHub tells you *where the code is*. But none of them fix anything. You still need a human in the loop, every single time.

## The Solution

**InariWatch is monitoring that fixes itself.**

When something breaks, AI reads your code, writes the fix, and opens a PR. CI passes. You approve. Or if you trust it enough — it merges automatically.

One sentence: **InariWatch is the autonomous immune system for your codebase.**

## How It Works (The Simple Version)

1. **Something breaks** — a Sentry error, a failed Vercel deploy, a GitHub CI failure, an Expo crash. InariWatch catches it.
2. **AI diagnoses it** — reads the stack trace, your codebase, and past incidents. Understands root cause in seconds.
3. **AI writes the fix** — a minimal, focused code change plus a regression test. Inside a sandboxed container where it can compile, build, and run tests before pushing.
4. **11 safety gates verify it** — CI, security scan, self-review, staging tests, I/O replay. All green? Auto-merge. One red? Draft PR for you.
5. **10 minutes of monitoring** — watches for regressions. If the fix broke something, auto-reverts to the last good deploy.

From error to merged PR in minutes — not days.

## The Vision

Software is the only engineered system that cannot heal itself. A cut heals. A circuit breaker trips and resets. But software just... stays broken until a human intervenes.

InariWatch is building the nervous system that makes software self-healing.

**Today:** When something breaks, InariWatch fixes it.
**Tomorrow:** Before something breaks, InariWatch prevents it.
**Eventually:** Software maintains itself — bugs, dependencies, security patches, performance tuning — and engineers build new things instead.

The insane question today: "You'd let AI push code to production?"

The insane question in five years: "You still wake up engineers at 3am?"

## The Founder Story

I'm Jesus Bernal, a solo founder from Mexico. I built InariWatch because I was tired of being the only developer on call, drowning in alerts, spending nights fixing bugs that an AI could have handled. I wanted a tool that doesn't just tell you something broke — it fixes it for you.

Every line of code in InariWatch — the web app, the AI pipeline, the Rust CLI, the eBPF kernel agent, the mobile app, the VS Code extension — I wrote it. Not because I had to, but because understanding the full stack is how you build something that actually works end to end.

Built in MX. Monitoring the world.

---

# Layer 2 — The Product

*For CTOs, developers, and technical audiences evaluating the product.*

---

## What InariWatch Does

InariWatch is an AI-powered monitoring platform that closes the loop from detection to resolution. It ingests alerts from your existing tools, enriches them with AI analysis, and — when confidence is high enough — fixes them autonomously.

### The Alert Lifecycle

```
Alert arrives → AI auto-analyzes → Diagnosis stored
                                        ↓
                         User clicks "Fix" (or autonomous mode triggers)
                                        ↓
                              Context gathering
                         (Sentry + Vercel + GitHub + Datadog + Code RAG)
                                        ↓
                              AI explores codebase
                         (Container Agent → Agentic Loop → Single-shot)
                                        ↓
                              Fix generated + regression test
                                        ↓
                              Security scan (3 layers)
                              Self-review (AI grades itself)
                                        ↓
                              Push to branch → CI runs
                              (up to 3 retries if CI fails)
                                        ↓
                              11 Safety Gates evaluate
                                        ↓
                    ┌─── All pass ───┐      ┌─── Any fail ───┐
                    │  Auto-merge    │      │   Draft PR      │
                    │  10-min watch  │      │   Human review  │
                    └────────────────┘      └─────────────────┘
                            ↓
                    Regression? → Auto-revert + Escalate
                    Clean? → Resolve + Contribute to community
```

### Core Features

**Alert Ingestion & AI Analysis**
Ingests from Sentry, Vercel, GitHub, Datadog, Expo, and your own app via the Capture SDK. Every alert gets free AI auto-analysis on arrival — root cause, severity assessment, and recommended action. No API key required; we fund the AI.

**AI Remediation Pipeline**
The full pipeline: diagnose, read code, generate fix, security scan, self-review, push, CI (3x retry), PR, auto-merge gates, post-merge monitoring, escalation if failed. Four fix strategies cascade based on infrastructure availability — from full container execution to single-shot generation.

**11 Safety Gates**
Before any auto-merge, the fix must pass:

| # | Gate | What it checks |
|---|------|----------------|
| 1 | Auto-merge enabled | Is the feature turned on for this project? |
| 2 | CI passed | All GitHub checks green? |
| 3 | Confidence threshold | AI confidence >= minimum (default 70%) |
| 4 | Lines changed | Under maximum (default 500 lines) |
| 5 | Self-review | AI reviewed its own fix and scored >= 70 |
| 6 | Substrate simulate | I/O replay risk score <= 40 |
| 7 | EAP chain verified | Cryptographic execution receipts valid |
| 8 | Prediction safe | Pre-deploy prediction risk <= 40 |
| 9 | Security scan | Zero HIGH-severity findings |
| 10 | Substrate replay | I/O replay confirms fix prevents the crash |
| 11 | E2E staging | Staging tests pass |

**Trust Levels**
Projects earn trust over time based on their AI fix track record:

| Level | Requirements | What changes |
|-------|-------------|--------------|
| Rookie | New project | Draft PRs only, no auto-merge |
| Apprentice | 3+ fixes, 50%+ success, 7 days | Strict: confidence >= 90, <= 50 lines |
| Trusted | 5+ fixes, 70%+ success, 14 days | Standard: confidence >= 80, <= 100 lines |
| Expert | 10+ fixes, 85%+ success, 30 days | Relaxed: confidence >= 70, <= 200 lines |

**Prediction Engine**
Three layers of pre-deployment risk assessment on every PR:
1. **Pattern matching** — compares PR diff against 90 days of historical alerts
2. **AI prediction** — predicts specific errors (file, line, confidence) before deployment
3. **Shadow replay** — runs PR code against recorded production I/O patterns

**Community Fix Network**
When InariWatch fixes an error, the pattern is anonymized and shared. The next team with the same error gets an instant match — because someone already solved it.

> "47 teams fixed this. 96% success rate. Apply in one click."

This is herd immunity for code. Every successful fix makes the entire network stronger.

**On-Call Scheduling**
Rotation schedules per project, multi-level escalation policies, schedule overrides, timezone-aware. When AI can't fix something, it escalates to the right person with full context.

**Auto-Heal**
When uptime monitoring detects your site is down (3 consecutive failures), InariWatch auto-rolls back to the last good deploy AND starts AI remediation simultaneously. 10-minute cooldown prevents loops.

**Post-Merge Monitoring**
After auto-merge, aggressive 10-minute canary monitoring checks Sentry for new errors, uptime for availability, and alert fingerprints for recurrence. If regression detected: auto-revert, escalate, and update status page.

**Status Page Automation**
Critical alerts auto-create public incidents. Updates during remediation. Auto-resolves when the fix ships. No manual status page management.

### Integration Ecosystem

InariWatch meets developers wherever they already work:

| Surface | What it does |
|---------|-------------|
| **Web Dashboard** | Full control — alerts, remediation live terminal, analytics, on-call, settings |
| **Capture SDK** | `npm i @inariwatch/capture` — zero deps, zero config error capture for Node.js/TypeScript |
| **MCP Server** | 25 tools for AI coding assistants (Claude Code, Cursor, Windsurf, Copilot, Codex, Gemini CLI) |
| **Slack Bot** | 14 slash commands, interactive buttons, [Fix It] in-thread, deploy health checks |
| **Telegram Bot** | 15 commands, inline keyboards, on-call tagging for critical alerts |
| **VS Code Extension** | Inline diagnostics, AI hover, sidebar alert list, status bar count |
| **GitHub Action** | AI risk assessment posted on every PR |
| **CLI (Rust)** | `inariwatch dev` catches local errors, diagnoses, applies fixes to disk |
| **Mobile App** | Push notifications, alert management (Expo React Native) |
| **Desktop App** | Native alert viewer (Tauri) |
| **InariWatch Agent** | Kernel-level eBPF observability — zero code changes, any language |

### AI Strategy

**Platform-funded.** All AI features work out of the box. We provide the AI keys (GPT-4o-mini for analysis, GPT-5.4 for remediation). No user setup required.

**Optionally BYOK.** Power users can bring their own key from Claude, OpenAI, Groq, Grok, DeepSeek, or Gemini to use specific models.

**MCP is sampling-first.** When AI coding assistants call InariWatch via MCP, the analysis happens on the client's LLM (Claude, GPT, etc.) — not ours. We provide the context; they do the thinking. Zero server-side AI cost for analysis tools.

### What Makes InariWatch Different

| | Sentry | PagerDuty | InariWatch |
|---|--------|-----------|------------|
| Detects errors | Yes | Via integrations | Yes |
| Notifies humans | Yes | Yes | Yes |
| Diagnoses root cause | No | No | Yes (AI) |
| Writes the fix | No | No | Yes (AI) |
| Verifies the fix | No | No | Yes (container, CI, 11 gates) |
| Auto-merges safely | No | No | Yes (with trust levels) |
| Monitors after merge | No | No | Yes (10-min canary) |
| Auto-reverts if broken | No | No | Yes |
| Learns from past fixes | No | No | Yes (community network) |
| Predicts before deploy | No | No | Yes (3-layer prediction) |

**The gap:** Sentry stops at detection. PagerDuty stops at notification. InariWatch closes the entire loop.

---

# Layer 3 — Under the Hood

*For deep technical dives, engineering conferences, and the founder's own reference.*

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        VERCEL (Production)                       │
│                                                                   │
│  Next.js 15 (App Router)                                         │
│  ├── 66+ API routes (webhooks, cron, auth, MCP, mobile, etc.)   │
│  ├── AI Layer (14+ modules in lib/ai/)                           │
│  ├── Service Layer (lib/services/ — SSOT for all business logic) │
│  ├── 8 Pollers (Sentry, Vercel, GitHub, Expo, npm, PG, uptime)  │
│  └── Drizzle ORM → Neon PostgreSQL                               │
│                                                                   │
│  Redis: Upstash (rate limiting, AI cache, dedup, health)         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐
│ Neon Postgres │  │   Upstash    │  │  Hetzner CX22            │
│               │  │   Redis      │  │  (2 vCPU, 4GB RAM)       │
│ pgvector      │  │              │  │                          │
│ (1024D HNSW)  │  │ Rate limits  │  │  ├── Go staging server   │
│               │  │ AI cache     │  │  │   (port 9400)         │
│ BM25 full-text│  │ Alert dedup  │  │  ├── Node.js AI worker   │
│               │  │ Service HP   │  │  │   (port 9401)         │
│               │  │ Slack cache  │  │  ├── Redis (Docker)      │
└──────────────┘  └──────────────┘  │  ├── Caddy (TLS)         │
                                     │  └── InariWatch Agent     │
                                     │      (eBPF)              │
                                     └──────────────────────────┘
```

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Framework | Next.js 15 (App Router) | Full-stack React, serverless on Vercel |
| Language | TypeScript | Type safety across the entire web stack |
| Database | Neon PostgreSQL + Drizzle ORM | Serverless Postgres, type-safe queries |
| Auth | NextAuth (credentials + Google) | Standard, extensible |
| AI | 6 providers (Claude, OpenAI, Groq, Grok, DeepSeek, Gemini) | No vendor lock-in |
| Deploy | Vercel | Zero-config, edge functions, instant rollbacks |
| Email | Resend (SMTP via Nodemailer) | Developer-friendly email API |
| Push | Web Push API + Expo Push | Browser + native mobile notifications |
| Messaging | Slack OAuth bot + Telegram Bot API | Where teams already communicate |
| Caching | Upstash Redis (Vercel) + self-hosted Redis (Hetzner) | ~1ms rate limiting, AI response caching |
| Search | pgvector (1024D HNSW) + BM25 full-text | Hybrid semantic + keyword code search |
| CLI | Rust | Fast, single static binary, cross-platform |
| Desktop | Tauri | Native performance, small bundle |
| Mobile | Expo React Native | Cross-platform with push notifications |
| Agent | C (eBPF kernel) + Rust (userspace) | Kernel-level observability, zero overhead |

## AI Pipeline Deep Dive

### Four Fix Strategies (Cascading Fallback)

```
Attempt 1:
  ├── Container Agent (Worker mode) ←── preferred: 40 turns, ~1ms tools, Docker on Hetzner
  ├── Container Agent (Vercel mode) ←── fallback: 15 turns, HTTP round-trips
  ├── Agentic Loop                  ←── Haiku explores (12 turns) → Sonnet fixes (3 turns)
  └── Single-shot                   ←── one prompt, full context

Retries (up to 3x):
  └── Single-shot with anti-patterns from failed attempts
```

**Container Agent** is the crown jewel. It clones the repo into Docker on Hetzner, gives the AI 6 tools (read, write, grep, exec, list, submit_fix), and lets it compile, build, and test before pushing. The AI self-corrects: if `tsc` fails, it reads the error and re-fixes.

**Security hardening:** Command whitelist, subshell/backtick/semicolon blocking, path traversal protection, symlink validation, tmpfs disk limits, input size limits.

### Cost Optimization

| Technique | Savings |
|-----------|---------|
| Prompt caching (`cache_control: { type: "ephemeral" }`) | ~$0.25-0.30/remediation |
| Model routing (Haiku for self-review + security, Sonnet for fixes) | ~40% per fix |
| MCP sampling-first (client LLM analyzes, not ours) | 100% on analysis tools |
| Redis AI cache (same fingerprint = cached response, 1h TTL) | Eliminates duplicate AI calls |
| **Estimated cost per remediation:** | **~$0.25** (down from ~$0.56) |

### Security Scanning (3 Layers)

| Layer | Engine | Coverage |
|-------|--------|----------|
| 1 | ESLint + eslint-plugin-security | 17 rules: unsafe eval, child_process, CSRF, timing attacks, bidi chars |
| 2 | 19 Semgrep-inspired regex patterns | SQL injection, XSS, command injection, prototype pollution, hardcoded secrets, SSRF, insecure crypto, CORS wildcard |
| 3 | AI security review (Claude) | 10 vulnerability categories, context-aware analysis |

All 3 layers merge with dedup. Runs entirely in-memory on Vercel serverless — no external CLI needed.

## InariWatch Agent (eBPF)

The agent provides kernel-level observability with zero code changes. Install with one command:

```bash
curl -sf https://install.inariwatch.com | sh
```

**Architecture:**
- **Kernel side (C):** ~10 BPF programs, 50-120 lines each. Attached to tracepoints, kprobes, and uprobes.
- **Userspace (Rust):** Ring buffer consumer, event processing, batch compression, HTTPS transport.

**7 Active Probes:**

| Probe | Hook Type | What it captures |
|-------|-----------|-----------------|
| Process | tracepoint/sched | Process exec, exit, fork |
| Network | tracepoint/sock + kprobe | TCP state changes, retransmits, send/recv |
| Filesystem | kprobe/vfs | File open, write, delete |
| DNS | kprobe/udp_sendmsg | DNS queries (raw capture, parsed in Rust) |
| Syscall | raw_tracepoint | System call dispatch |
| TLS | uprobe on SSL_read/write | Encrypted traffic interception |
| Security | LSM hooks | Security policy enforcement |

**Design decisions:**
- DNS parsing in Rust, not kernel (BPF verifier rejects complex loops — same pattern as Datadog, Coroot)
- TLS: scans `/proc/PID/maps` every 30s for libssl.so, attaches uprobes dynamically
- CO-RE: single static binary for all kernels 5.8+ (no clang/headers on target)
- Performance: 248 events/sec, ~88% LZ4 compression, <1% CPU

**Threat detection (cloud-side):** SQL injection, XSS, SSRF, command injection, reverse shells, web shells, container escape, sensitive file access, malicious DNS.

## EAP (Execution Attestation Protocol)

Cryptographic proof chain for AI fix verification. 6 Rust crates in `orbita-pos/eap`.

- **Merkle trees** — content-addressed verification of fix steps
- **Ed25519 signatures** — non-repudiation of AI decisions
- **Use case:** Prove that a specific AI model generated a specific fix, reviewed by a specific security scan, passing specific CI checks. Audit trail for regulated industries.

## Substrate (I/O Recording)

Deterministic I/O recording and replay. 10 Rust crates in `orbita-pos/substrate`.

- Records HTTP requests, database queries, file reads, external API calls
- Ring buffer design — captures the last N operations, auto-flushes on error
- **Replay modes:** AI analysis (fast, serverless) + GitHub Action (real I/O verification)
- **Use case:** When an error happens, you get the exact I/O sequence that led to it. When a fix is proposed, you replay that sequence to verify the fix actually prevents the crash.

## Infrastructure Numbers

| Metric | Number |
|--------|--------|
| API routes | 66+ |
| MCP tools | 25 |
| Slack commands | 14 |
| Telegram commands | 15 |
| Safety gates | 11 |
| AI modules | 14+ |
| Pollers | 8 |
| Chaos tests (Vitest) | 103 |
| k6 stress test scenarios | 14 (10 load + 4 chaos) |
| Security scan rules | 36+ (17 ESLint + 19 regex + AI) |
| eBPF probes | 7 |
| Cron jobs | 5 |

## Chaos Engineering & Stress Testing

**Chaos tests (103 tests, 3 levels):**
- L1 Unit: AI timeout/retry, notification failures, dedup races, SSE memory leaks
- L2 Integration: Alert storms, escalation without on-call, auto-heal cascades, remediation under GitHub API failure
- L3 Security: 46 SSRF bypass vectors, X-Forwarded-For spoofing, webhook signature edge cases, 14 XSS payloads across Slack/Telegram/JSX

**k6 stress tests (14 scenarios):**
- Webhook storm, MCP rate limits, 50 concurrent SSE connections, alert dedup, auth brute force, cron fan-out, DB saturation, push serialization, auto-heal, full incident lifecycle, chaos variants with mixed valid/malformed payloads

## Service Architecture

All business logic lives in `lib/services/`. Every surface (MCP, Slack, Telegram, dashboard, extension, cron, mobile, desktop) calls these services instead of reimplementing queries.

```
  MCP ─────┐
  Slack ────┤
  Telegram ─┤
  Dashboard ┼──→ Service Layer (lib/services/) ──→ Drizzle ORM ──→ Neon PostgreSQL
  VS Code ──┤                                  └──→ Redis (cache)
  Mobile ───┤
  CLI ──────┘
```

**Key services:**
- `alerts.service.ts` — query, get, silence, acknowledge, reopen, stats, trends
- `diagnosis.service.ts` — AI diagnosis with prompt SSOT
- `vercel.service.ts` — deployments, rollback, build logs
- `chat.service.ts` — Ask Inari context gathering
- `code-intelligence.service.ts` — hybrid search, reindexing, call graph
- `url-validation.ts` — SSRF protection

---

# Layer 4 — The Roadmap

*Strategic direction and where the product is going.*

---

## The Flywheel

InariWatch has a data flywheel that gets stronger with every user:

```
More users → More fixes → More community patterns → Better predictions
     ↑                                                        │
     └────────── Faster fixes attract more users ←────────────┘
```

**Scale milestones:**
- **50+ users:** Ship anonymized repair pattern telemetry
- **500+ users:** Predictive model ("this PR pattern causes incidents in 12% of similar deploys")
- **1,000+ users:** Community handles common framework bugs autonomously
- **5,000+ users:** Open-source the pattern format — become the protocol, not just the product
- **100,000+ users:** Predict failures before they happen
- **1,000,000+ users:** "Your Monday deploy has a 23% chance of triggering a latency spike"

## Three Strategic Directions

### Direction A — Inari Cortex (Software Immune System)

The repair loop today is the *innate* immune system — generic defense. The next step is *adaptive* immunity:
- **Memory cells:** Fix patterns stored, recalled instantly on recurrence
- **Antibody generation:** Pre-staged patches for known CVEs before they hit your code
- **Immune tolerance:** Learn from tests/docs what's intentional vs. what's a bug

### Direction B — Inari Network (Global Resilience Graph)

This is the real bet. The differentiator isn't the AI — it's the data.
- Every fix that succeeds feeds the community network
- Every failure teaches the predictive model
- Whoever accumulates the largest corpus of real-world repair patterns first wins

### Direction C — Inari OS (End of Software Maintenance)

Expand from bugs to everything that keeps engineers awake:
1. Bugs (today)
2. Dependency upgrades + security patches
3. Performance self-tuning from production telemetry
4. Schema migrations, infrastructure drift correction
5. Feature evolution from user behavior

---

# Quick Reference — The Pitch

*Use these for different audiences and time constraints.*

---

**5-second pitch:**
> Monitoring that fixes itself.

**30-second pitch:**
> InariWatch monitors your app, and when something breaks, AI reads your code, writes the fix, and opens a PR. 11 safety gates verify it. If all pass, it auto-merges. If the fix causes a regression, it auto-reverts. From error to merged PR in minutes.

**2-minute pitch:**
> Every developer knows the 3am page. Sentry tells you something broke. PagerDuty wakes you up. But you still have to diagnose the root cause, write the fix, test it, and deploy it yourself.
>
> InariWatch closes that loop. It ingests alerts from Sentry, Vercel, GitHub, Datadog — any source. AI auto-analyzes every alert on arrival. When you click "Fix" — or in autonomous mode, automatically — it reads your codebase inside a sandboxed container, writes a minimal fix plus a regression test, runs it through 11 safety gates including CI, security scan, and I/O replay, and opens a PR. If everything passes, it auto-merges. Then it monitors for 10 minutes. If the fix causes a regression, it auto-reverts and escalates.
>
> But here's what makes it different: every fix that succeeds gets anonymized and shared across the network. The next team with the same error gets an instant match. And our prediction engine catches bugs before they hit production — analyzing PR diffs against historical patterns and replaying recorded I/O.
>
> We're platform-funded — all AI features work out of the box, no API keys needed. The product is live, in beta, and free. We have a Capture SDK, Slack and Telegram bots, a VS Code extension, an MCP server with 25 tools for AI coding assistants, a Rust CLI, mobile and desktop apps, and a kernel-level eBPF agent that monitors any language with zero code changes.
>
> Built by a solo founder in Mexico. Every line of code. The vision is simple: make software self-healing so engineers can build instead of firefight.

---

*This document is a living reference. Update it as the product evolves.*
