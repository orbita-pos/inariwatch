// `@inariwatch/capture/auto` reads the following env vars at boot:
//   INARIWATCH_DSN          — error sink endpoint
//   INARIWATCH_RELEASE      — release tag
//   INARIWATCH_SUBSTRATE    — opt-in I/O recording
//   INARIWATCH_CAPTURE_V2   — opt-in v2 integrations (agent / fleet / forensic)
//   INARIWATCH_REDACT       — opt-in in-process PII / secret scrub (v0.3 S6)
// Set INARIWATCH_REDACT=true in prod env so dogfood alerts can never
// carry user PII we shouldn't see, even if a stack trace happens to
// include an email or a JWT.
import "@inariwatch/capture/auto";
import { captureRequestError } from "@inariwatch/capture";

export const onRequestError = captureRequestError;
