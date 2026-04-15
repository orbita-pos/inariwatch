# @inariwatch/capture-replay

Session replay for `@inariwatch/capture` — captures the DOM + network + console for every user session so you can reproduce bugs frame-by-frame. Automatic PII masking. 150 KB gzipped, lazy-loaded.

## Install

```bash
npm install @inariwatch/capture @inariwatch/capture-replay
```

`rrweb` is bundled internally — no additional install required.

## Usage (Next.js App Router)

```tsx
// app/capture-init.tsx
"use client"
import { useEffect } from "react"

export function CaptureInit() {
  useEffect(() => {
    void (async () => {
      const [{ init }, { replayIntegration }] = await Promise.all([
        import("@inariwatch/capture"),
        import("@inariwatch/capture-replay"),
      ])

      init({
        dsn: process.env.NEXT_PUBLIC_INARIWATCH_DSN,
        projectId: process.env.NEXT_PUBLIC_INARIWATCH_PROJECT_ID,
        integrations: [replayIntegration()],
      })
    })()
  }, [])
  return null
}
```

```tsx
// app/layout.tsx
import { CaptureInit } from "./capture-init"

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <CaptureInit />
        {children}
      </body>
    </html>
  )
}
```

## Options

```ts
replayIntegration({
  blockDurationSec: 30,           // flush interval (default: 30s)
  maxBufferBytes: 262144,         // force flush at 256 KB
  piiClassifier: "ai",            // "ai" | "heuristic" | false (default: "ai")
  maskAllInputs: false,           // override classifier (default: false when classifier is on)
  redactSelectors: [".secret"],   // always-redacted CSS selectors
  endpoint: "https://app.inariwatch.com",  // override (default: parsed from DSN)
})
```

## PII masking

By default (`piiClassifier: "ai"`) every `<input>` is classified:

- **Tier 1 — heuristics (synchronous, ~25 rules):** `type=password`, `autocomplete=cc-number`, `name~="ssn"`, etc. Covers 90%+ of common PII.
- **Tier 2 — AI classifier (optional, batched):** ambiguous fields are sent to `/api/replay/classify-pii` (GPT-4o-mini). Runs in background, ~500ms.
- **Fail-closed:** while Tier 2 is pending, the field is preemptively masked. Only un-masked if the AI returns `not_pii` with high confidence.

No field content ever leaves the browser — only metadata (name, label, placeholder).

Set `piiClassifier: false` if you prefer the simpler `maskAllInputs: true` behaviour.

## Security

- Browser sends POST to `/api/replay/ingest` with a 30-second block
- Server validates `projectId`, `Origin` header (allowlist configurable per project), per-IP + per-project rate limits
- Blocks land in Cloudflare R2; signed URLs expire in 5 min
- Session ids are 128-bit crypto-random — not guessable

## Bundle impact

- `@inariwatch/capture` alone: ~32 KB gzipped
- `@inariwatch/capture-replay` added: +150 KB gzipped (rrweb + PII classifier)
- Both are lazy-loaded via `import()` so initial page render is unaffected

## License

MIT — © Jesus Bernal
