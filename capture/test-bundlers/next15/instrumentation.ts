// Mirrors the global CLAUDE.md instruction for new Node projects:
//   - `@inariwatch/capture/auto` for global init
//   - `captureRequestError` re-exported as `onRequestError` so Next's
//     instrumentation API picks up unhandled request-level errors.
//
// This file is what every Next.js user creates. The validation point:
// after `next build`, the produced bundles must not contain the heavy
// redact / intent / causal modules — they should be runtime-resolved.
import "@inariwatch/capture/auto"
import { captureRequestError } from "@inariwatch/capture"
export const onRequestError = captureRequestError
