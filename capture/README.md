# @inariwatch/capture

Lightweight error capture SDK for [InariWatch](https://inariwatch.com) — zero dependencies, works everywhere Node runs.

Drop-in alternative to Sentry's SDK. Captures exceptions, structured logs, and deploy markers from your app and sends them to InariWatch for AI-powered analysis and remediation.

## Install

```bash
npm install @inariwatch/capture
```

## Quick start

```typescript
import { init, captureException, captureLog, captureMessage } from "@inariwatch/capture";

init({
  dsn: "https://app.inariwatch.com/api/webhooks/capture/YOUR_PROJECT_ID",
  environment: "production",
  release: "1.2.0",
});
```

## API

### `init(config)`

Initialize the SDK. Call once at app startup.

| Option | Type | Description |
|--------|------|-------------|
| `dsn` | `string` | **Required.** Your project's capture endpoint |
| `environment` | `string` | Environment tag (e.g. `"production"`, `"preview"`) |
| `release` | `string` | Release version — also triggers a deploy marker event |
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
captureLog("Database connection timeout", "error", { host: "db.example.com", latency: 5200 });
```

Levels: `"debug"` | `"info"` | `"warn"` | `"error"` | `"fatal"`

### `captureMessage(message, level?)`

Send a plain text event.

```typescript
captureMessage("Deploy v1.2.0 started", "info");
```

### `flush()`

Wait for all pending events to be sent. Call this before process exit or serverless function return.

```typescript
await flush();
```

### `captureRequestError(error, request, context)`

Next.js `instrumentation.ts` helper — captures server-side errors with route and request context.

```typescript
// instrumentation.ts
import { captureRequestError } from "@inariwatch/capture";

export function onRequestError(error, request, context) {
  captureRequestError(error, request, context);
}
```

## Express example

```typescript
import express from "express";
import { init, captureException, flush } from "@inariwatch/capture";

init({ dsn: "https://app.inariwatch.com/api/webhooks/capture/YOUR_PROJECT_ID" });

const app = express();

app.use((err, req, res, next) => {
  captureException(err);
  res.status(500).json({ error: "Internal server error" });
});

process.on("SIGTERM", async () => {
  await flush();
  process.exit(0);
});
```

## Local development

When the DSN points to `localhost`, events are routed to the CLI capture server automatically:

```typescript
init({ dsn: "http://localhost:9111/ingest" });
```

Run `inariwatch watch` to receive events locally.

## Features

- **Zero dependencies** — just `fetch` (built into Node 18+)
- **9.8 kB** package size
- **Auto deploy detection** — setting `release` sends a deploy marker
- **Retry buffer** — failed events are retried automatically (up to 30)
- **Fingerprinting** — deduplicates identical events
- **`beforeSend` hook** — filter or transform events before they leave your app
- **HMAC signing** — events are signed for webhook verification
- **ESM-only** — modern `import`/`export`

## Docs

Full documentation: [inariwatch.com/docs#int-capture](https://inariwatch.com/docs#int-capture)

## License

MIT
