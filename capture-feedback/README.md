# @inariwatch/capture-feedback

User feedback widget for [`@inariwatch/capture`](https://www.npmjs.com/package/@inariwatch/capture). Floating button + modal with optional screenshot. Zero external dependencies — uses the browser's native Screen Capture API.

## Install

```bash
npm install @inariwatch/capture @inariwatch/capture-feedback
```

## Usage

```ts
import { init } from "@inariwatch/capture"
import { feedbackIntegration } from "@inariwatch/capture-feedback"

init({
  dsn: process.env.NEXT_PUBLIC_INARIWATCH_DSN,
  integrations: [feedbackIntegration()],
})
```

A "Report a bug" button appears in the bottom-right corner. Clicking it opens a modal where users can:
- describe what happened
- enter an email (optional)
- attach a screenshot (optional — uses native `getDisplayMedia` with browser consent)

## Options

```ts
feedbackIntegration({
  position: "bottom-right",         // or "bottom-left" | "top-right" | "top-left"
  buttonLabel: "Feedback",          // button text
  title: "How can we help?",        // modal title
  userEmail: "jane@acme.com",       // pre-fill email field
  accentColor: "#6366f1",           // primary button color
  hideButton: false,                // hide floating button, trigger programmatically
  onSubmit: (payload) => {
    console.log(payload)
    // return false to prevent default captureLog send
  },
})
```

## What gets reported

Feedback lands in your dashboard as an info-level log:

```json
{
  "title": "feedback: Navigation is broken on mobile",
  "severity": "info",
  "metadata": {
    "kind": "user_feedback",
    "description": "...",
    "email": "...",
    "url": "...",
    "viewport": { "width": 1280, "height": 720 },
    "hasScreenshot": true,
    "screenshot": "data:image/jpeg;base64,..."
  }
}
```

## Privacy

- Screenshots require **explicit browser permission** — the user sees a native dialog and picks what to share. No silent capture.
- Screenshots are down-scaled to max 1600px wide, JPEG @ 78% quality (~300 KB average).
- `description` is capped at 5,000 characters, `email` at 200, `userAgent` at 300.

## Bundle impact

- This integration: ~4 KB gzipped (widget + styles inlined)
- Zero external deps — no `html2canvas`, no `rrweb`, no UI libraries

## License

MIT
