# Migration guide — `@inariwatch/capture` 0.6.x → 0.7.0

## Who this affects

**Error-only users (no session replay):** zero changes needed. Upgrade and go.

**Users opting into session replay:** one config shape change, described below.

---

## What changed

`@inariwatch/capture` 0.7.0 extracted session replay into its own package:
`@inariwatch/capture-replay`. This keeps the core SDK at ~32 KB for
error-tracking users, and moves `rrweb` from a manual peer-dependency install
to an internal dependency of the replay package.

Pattern: integration-based (Sentry-style) instead of a `replay: true` boolean.

## Before (0.6.x)

```ts
// Required peer install:
// npm install @inariwatch/capture rrweb

init({
  dsn: "...",
  projectId: "...",
  replay: { piiClassifier: "ai" },
})
```

## After (0.7.0+)

```ts
// Single install, rrweb bundled automatically:
// npm install @inariwatch/capture @inariwatch/capture-replay

import { init } from "@inariwatch/capture"
import { replayIntegration } from "@inariwatch/capture-replay"

init({
  dsn: "...",
  projectId: "...",
  integrations: [
    replayIntegration({ piiClassifier: "ai" }),
  ],
})
```

## Why the change

1. **Error-only users** stopped paying a 150 KB bundle tax for features they don't use.
2. **Replay users** stopped needing a manual `npm install rrweb`.
3. **Future features** (performance, feedback widget, …) slot into the same
   `integrations` array without touching the core.

This matches Sentry's `integrations: [replayIntegration()]`, Datadog's
`-slim` vs full package split, and how Anthropic structures optional SDK
features.

## Breaking changes

- `CaptureConfig.replay` was removed. Use `integrations: [replayIntegration()]`.
- `ReplayConfig` type was moved from `@inariwatch/capture` to
  `@inariwatch/capture-replay`. Update imports:

  ```diff
  - import type { ReplayConfig } from "@inariwatch/capture"
  + import type { ReplayConfig } from "@inariwatch/capture-replay"
  ```

## Unchanged

- `init()` signature (except `replay` field)
- `captureException`, `captureMessage`, `captureLog`, `flush`
- `addBreadcrumb`, `setUser`, `setTag`, `setRequestContext`
- `@inariwatch/capture/auto`, `/next`, `/browser`, `/shield` sub-paths
- `withInariWatch(nextConfig)` plugin

## Uninstall rrweb (if you installed it manually)

After upgrading, the `rrweb` top-level dep in your `package.json` is no
longer required — it's now an internal dep of `@inariwatch/capture-replay`:

```bash
npm uninstall rrweb
```

Optional; leaving it doesn't break anything.
