# Integrations

InariWatch gathers context from multiple services to diagnose errors accurately. Each integration adds a layer of information the AI uses to write better fixes.

## Context Sources

| Integration | What it provides | Required? |
|------------|-----------------|-----------|
| **GitHub** | CI logs, repo tree, file contents, PR creation | Yes (core) |
| **Sentry** | Stack traces, breadcrumbs, event tags, issue details | No |
| **Vercel** | Build logs, deployment context, rollback capability | No |
| **Datadog** | Performance metrics for affected monitors | No |
| **Substrate** | Full I/O recording (HTTP, DB, file ops), session replay | No |
| **EAP** | Cryptographic execution receipts for verification chain | No |
| **@inariwatch/capture** | Direct error capture from your app (replaces Sentry) | No |

## What Happens Without Each Integration

- **No Sentry** — AI diagnoses from error title/body + CI logs only. Less accurate for runtime errors.
- **No Vercel** — No build logs. Build failures diagnosed from CI output instead.
- **No Datadog** — No performance context. Doesn't affect code-level diagnosis.
- **No Substrate** — Simulate and replay gates skipped. No browser session replay in staging.
- **No EAP** — EAP chain gate skipped. Doesn't block the pipeline.
- **No GitHub** — Pipeline cannot run. GitHub is required for branch/PR creation.

## Setup

### GitHub
Connected via OAuth during project setup. Requires:
- Repository access (contents: read/write)
- Pull requests (read/write)
- Checks (read)

### Sentry
Add your Sentry auth token and organization slug in **Settings > Integrations > Sentry**.

### Vercel
Connect via OAuth in **Settings > Integrations > Vercel**. Provides team ID and access token.

### Datadog
Add your API key and application key in **Settings > Integrations > Datadog**. Used to query monitor details when a Datadog alert is received.

### @inariwatch/capture
Install the SDK in your app:
```bash
npm install @inariwatch/capture
```

For Next.js, add to `next.config.ts`:
```typescript
import { withInariWatch } from "@inariwatch/capture/next"
export default withInariWatch(nextConfig)
```

Set `INARIWATCH_DSN` for cloud mode. No DSN needed for local development.

## Graceful Degradation

If a service is temporarily down, the bot continues without that context source. The AI receives whatever context is available and works with what it has.

The PR body includes a **Context sources** line showing which integrations were available:

```
Context sources: sentry: ✓, vercel: ✓, github: ✓, datadog: ✗ (down), staging: ✓, eap: ✓, substrate: ✓
```

This tells the reviewer what information the bot had when it wrote the fix. If a source shows `✗`, the bot had less context than usual — the reviewer should consider that when evaluating the fix.
