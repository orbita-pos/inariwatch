# @inariwatch/capture

Lightweight error capture SDK for [InariWatch](https://inariwatch.com) — zero dependencies, works everywhere Node runs.

## Quick start

```bash
npx @inariwatch/capture
```

One command. Auto-detects your framework, installs, and starts capturing errors to your terminal. No signup. No config.

When you're ready for the cloud dashboard, add one env var:

```env
INARIWATCH_DSN=https://app.inariwatch.com/api/webhooks/capture/YOUR_ID
```

## Next.js

The CLI sets this up automatically, but if you prefer manual:

```typescript
// next.config.ts — one line
import { withInariWatch } from "@inariwatch/capture/next"
export default withInariWatch(nextConfig)
```

```typescript
// instrumentation.ts
import "@inariwatch/capture/auto"
import { captureRequestError } from "@inariwatch/capture"

export const onRequestError = captureRequestError
```

## Any Node.js app

```bash
node --import @inariwatch/capture/auto app.js
```

Or in package.json:

```json
{ "scripts": { "start": "node --import @inariwatch/capture/auto src/index.js" } }
```

## Manual init

If you need more control:

```typescript
import { init, captureException } from "@inariwatch/capture";

init({
  environment: "production",
  release: "1.2.0",
});
```

DSN is read from `INARIWATCH_DSN` env var automatically. No DSN = local mode (terminal output).

## Substrate (full I/O recording)

Capture every HTTP call, DB query, and file operation alongside your errors:

```bash
npm install @inariwatch/substrate-agent
```

```env
INARIWATCH_SUBSTRATE=true
```

Or programmatically:

```typescript
init({ substrate: true });
```

When `captureException()` fires, the last 60 seconds of I/O are uploaded with the error.

## Environment variables

| Variable | Description |
|----------|-------------|
| `INARIWATCH_DSN` | Capture endpoint. Omit for local mode. |
| `INARIWATCH_ENVIRONMENT` | Environment tag (fallback: `NODE_ENV`) |
| `INARIWATCH_RELEASE` | Release version |
| `INARIWATCH_SUBSTRATE` | Set to `"true"` to enable I/O recording |

## API

### `init(config?)`

Initialize the SDK. Call once at app startup. All options are optional — config is read from env vars.

| Option | Type | Description |
|--------|------|-------------|
| `dsn` | `string` | Capture endpoint (default: `INARIWATCH_DSN` env var) |
| `environment` | `string` | Environment tag (default: `INARIWATCH_ENVIRONMENT` or `NODE_ENV`) |
| `release` | `string` | Release version — also triggers a deploy marker |
| `substrate` | `boolean \| object` | Enable I/O recording (requires `@inariwatch/substrate-agent`) |
| `debug` | `boolean` | Log transport errors to console |
| `silent` | `boolean` | Suppress all console output |
| `beforeSend` | `(event) => event \| null` | Transform or drop events before sending |

### `captureException(error, context?)`

```typescript
try {
  await riskyOperation();
} catch (err) {
  captureException(err as Error);
}
```

### `captureLog(message, level?, metadata?)`

```typescript
captureLog("DB timeout", "error", { host: "db.example.com", latency: 5200 });
```

### `captureMessage(message, level?)`

```typescript
captureMessage("Deploy started", "info");
```

### `flush()`

Wait for pending events before process exit.

```typescript
await flush();
```

## Exports

| Import | Description |
|--------|-------------|
| `@inariwatch/capture` | SDK — `init`, `captureException`, `captureLog`, `flush` |
| `@inariwatch/capture/auto` | Auto-init on import — config from env vars |
| `@inariwatch/capture/next` | Next.js plugin — `withInariWatch()` |

## Features

- **Zero config** — `npx @inariwatch/capture` and you're done
- **Zero dependencies** — just `fetch` (Node 18+)
- **Env var driven** — no DSN in source code, `INARIWATCH_DSN` from env
- **Local mode** — works without signup, errors print to terminal
- **Substrate** — full I/O recording with one env var
- **Auto framework detection** — Next.js, Express, Node.js
- **Deploy markers** — setting `release` sends a deploy event
- **Retry buffer** — failed events retry automatically
- **HMAC signing** — events signed for webhook verification

## License

MIT
