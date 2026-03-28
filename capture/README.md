# @inariwatch/capture

Lightweight error capture SDK for [InariWatch](https://inariwatch.com) — zero dependencies, works everywhere Node runs.

Drop-in alternative to Sentry's SDK. Captures exceptions, structured logs, and deploy markers from your app and sends them to InariWatch for AI-powered analysis and remediation.

## Quick start (zero config)

One command. No signup. No DSN.

```bash
npx @inariwatch/capture
```

That's it. Auto-detects your framework (Next.js, Express, Node.js), installs, and starts capturing errors to your terminal.

When you're ready for the cloud dashboard:

```bash
npx @inariwatch/capture link
```

## Manual install

```bash
npm install @inariwatch/capture
```

```typescript
import { init, captureException } from "@inariwatch/capture";

// Local mode — no DSN needed, errors print to terminal
init({});

// Cloud mode — errors go to your InariWatch dashboard
init({
  dsn: "https://app.inariwatch.com/api/webhooks/capture/YOUR_PROJECT_ID",
  environment: "production",
  release: "1.2.0",
});
```

## Substrate (full I/O recording)

Capture every HTTP call, DB query, and file operation alongside your errors:

```bash
npm install @inariwatch/capture @inariwatch/substrate-agent
```

```typescript
init({
  dsn: "...",
  substrate: true, // activates ring buffer recording
});
```

When `captureException()` fires, the last 60 seconds of I/O are automatically uploaded with the error. The AI sees exactly what your code did — not just the stack trace.

## API

### `init(config)`

Initialize the SDK. Call once at app startup.

| Option | Type | Description |
|--------|------|-------------|
| `dsn` | `string` | Capture endpoint. Omit for local mode (terminal output) |
| `environment` | `string` | Environment tag (e.g. `"production"`, `"preview"`) |
| `release` | `string` | Release version — also triggers a deploy marker event |
| `substrate` | `boolean \| object` | Enable Substrate I/O recording (requires `@inariwatch/substrate-agent`) |
| `debug` | `boolean` | Log transport errors to console |
| `silent` | `boolean` | Suppress all console output |
| `beforeSend` | `(event) => event \| null` | Transform or drop events before sending |

### `captureException(error, context?)`

Capture a caught exception with full stack trace.

```typescript
try {
  await riskyOperation();
} catch (err) {
  captureException(err as Error);
}
```

### `captureLog(message, level?, metadata?)`

Send a structured log event.

```typescript
captureLog("Database connection timeout", "error", {
  host: "db.example.com",
  latency: 5200,
});
```

Levels: `"debug"` | `"info"` | `"warn"` | `"error"` | `"fatal"`

### `captureMessage(message, level?)`

Send a plain text event.

```typescript
captureMessage("Deploy v1.2.0 started", "info");
```

### `flush()`

Wait for all pending events to be sent. Call before process exit or serverless return.

```typescript
await flush();
```

### `captureRequestError(error, request, context)`

Next.js `instrumentation.ts` helper — captures server-side errors with route and request context.

```typescript
// instrumentation.ts
import { init, captureRequestError } from "@inariwatch/capture";

init({});

export const onRequestError = captureRequestError;
```

## Next.js

```bash
npx @inariwatch/capture
```

Auto-creates `instrumentation.ts` with error capture. Works with App Router and Pages Router.

## Express

```typescript
import express from "express";
import { init, captureException, flush } from "@inariwatch/capture";

init({});

const app = express();

app.use((err, req, res, next) => {
  captureException(err, { request: { method: req.method, url: req.url } });
  res.status(500).json({ error: "Internal server error" });
});

process.on("SIGTERM", async () => {
  await flush();
  process.exit(0);
});
```

## CLI commands

| Command | Description |
|---------|-------------|
| `npx @inariwatch/capture` | Auto-setup in your project (zero config) |
| `npx @inariwatch/capture link` | Connect to InariWatch cloud (add DSN) |

## Features

- **Zero config** — `npx @inariwatch/capture` and you're done
- **Zero dependencies** — just `fetch` (built into Node 18+)
- **Local mode** — works without signup, errors print to terminal
- **Substrate integration** — full I/O recording with `substrate: true`
- **Auto framework detection** — Next.js, Express, Node.js
- **Auto deploy detection** — setting `release` sends a deploy marker
- **Retry buffer** — failed events are retried automatically (up to 30)
- **Fingerprinting** — deduplicates identical events
- **HMAC signing** — events are signed for webhook verification
- **ESM-only** — modern `import`/`export`

## Docs

Full documentation: [inariwatch.com/docs#int-capture](https://inariwatch.com/docs#int-capture)

## License

MIT
