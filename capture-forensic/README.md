# @inariwatch/node-forensic

Forensic frame capture for `@inariwatch/capture` — pulls locals + closures + `this` at the moment a throw propagates, without keeping the runtime in slow-path.

Status: **alpha, inspector fallback only**. The ForensicVM fork (V8 + CPython) lands in follow-up releases. Public API is frozen so the fork integration is a drop-in upgrade.

## Install

```bash
npm install @inariwatch/node-forensic
```

Zero runtime dependencies. Node 20+ required.

## Usage

```ts
import { registerForensicHook } from "@inariwatch/node-forensic"

await registerForensicHook((capture) => {
  // capture.frames — innermost first
  // capture.frames[0].locals — [{ name, repr, kind, truncated? }, …]
  // capture.frames[0].closure — captured variables
  // capture.frames[0].receiver — `this` if any
  // capture.source — "fork" when running under ForensicVM, "inspector" otherwise
  // capture.captureDurationMs — wall-clock budget used
  // capture.sessionId / pid / tid / tsNs — stitching metadata for the eBPF agent
})
```

Pair it with `@inariwatch/capture`:

```ts
import { init, captureException } from "@inariwatch/capture"
import { registerForensicHook } from "@inariwatch/node-forensic"

init({ dsn: process.env.INARIWATCH_DSN })
await registerForensicHook((capture) => {
  // hand frames to captureException via the v2 `evidence.stack[i].locals` field
})
```

## Resolution order

1. **ForensicVM fork** — when `process.versions.iw_forensic` is set, the N-API bridge serves frame locals without entering V8's slow path. Budget: <1ms p50.
2. **Inspector fallback** — plain Node.js. Uses `inspector.Session` + `Debugger.paused`. Budget: 2–6ms p50 (Debugger domain runs V8 in slow path while scopes are read). See `FORENSIC_VM_DESIGN.md` §2.4.

Pass `{ forceFallback: true }` to exercise the fallback path even when the fork is present (used by the benchmark suite).

## Options

| Option | Default | Notes |
|---|---|---|
| `maxFrames` | 32 | Innermost frames kept; outer frames dropped. |
| `maxLocalsPerFrame` | 50 | Locals + closures combined cap per frame. |
| `maxValueDepth` | 2 | Object walk depth before `[Ctor]` placeholder. |
| `maxValueBytes` | 1024 | Per-value serialization byte cap. |
| `captureBudgetMs` | 5 | Hard wall on the whole capture; frames beyond get `<budget-exceeded>` markers. |
| `forceFallback` | false | Ignore fork even if available. |
| `rethrowHookErrors` | false | Re-throw user-hook errors instead of swallowing. |

## Shape

See `src/types.ts` for the canonical definitions. The shape is frozen — the ForensicVM fork emits the same `FrameSnapshot[]` through an N-API bridge so consumers don't branch on `source`.

## Fallback caveats

The inspector fallback enables the CDP `Debugger` domain for the lifetime of the hook. That:

- Disables some V8 optimizations on the paused frame. Non-paused frames are unaffected.
- Adds ~1–4ms per captured throw (depends on frame count and live objects).
- Requires Node built with inspector support (the default — deny-listed only in some edge runtimes).

If you need sub-millisecond capture on prod hot paths today, guard the hook behind a flag and enable only when a precursor signal (e.g. error rate spike) warrants it. Once the ForensicVM fork ships this caveat goes away.

## License

MIT
