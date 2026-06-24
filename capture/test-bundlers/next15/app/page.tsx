import { captureMessage } from "@inariwatch/capture"

// The whole point: a public-facing import of the SDK. Whatever this
// page imports + whatever `instrumentation.ts` imports IS the bundle
// surface a real user pays. `verify-bundle.mjs` reads .next/static/**
// and asserts the heavy modules don't appear there.
export default function Page() {
  return (
    <main>
      <h1>Inari Capture — Next.js 15 bundle shape validation</h1>
      <p>This page exists only so Next has something to render. The validation lives in `scripts/verify-bundle.mjs`.</p>
    </main>
  )
}

export async function generateMetadata() {
  // Touch a public API at the page level so tree-shaking can't drop
  // the import altogether. We don't actually want to send anything —
  // there's no DSN set. captureMessage no-ops without init.
  void captureMessage
  return { title: "Inari Capture bundle test" }
}
