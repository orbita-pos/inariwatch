// User-sidecar (Inari Live) provider adapter — v0.3 S2.
//
// Per INARI_AI_ARCHITECTURE.md §3 (substrate=user-sidecar) and §4 (relay).
// Web's router calls this adapter when a routing rule resolves to
// substrate "user-sidecar". The adapter forwards to the user's local
// Inari Live via the WS relay (relay.inariwatch.com /dispatch).
//
// Responsibilities of THIS file:
// 1. Translate the standard CompleteOpts / ToolUseOpts / VisionOpts into
//    a relay payload (`{ user_id, task, payload }`).
// 2. Map relay errors (offline / timeout / disconnect) into standard
//    `Error` instances whose messages match the dispatch core's
//    fallback-trigger patterns ("sidecar-offline", "sidecar-timeout",
//    "sidecar"). The router then transparently re-runs the task on the
//    cloud fallback without the caller noticing.
// 3. Capture the user-signed Ed25519 receipt the sidecar emits and
//    surface it via takeLastUserSidecarReceipt() — web persists it
//    without re-signing (per S27/S28 chain rules).
//
// What this file does NOT do:
// - Sign receipts itself. The sidecar is the only signer for
//   user-sidecar dispatches; web is a verifier + persister.
// - Decide WHICH user_id receives the dispatch. The dispatch core
//   passes a `workspace.userId`; if absent we throw `sidecar-offline`
//   (no addressable target).

import type {
  AIResponse,
  CompleteOpts,
  StreamCompleteOpts,
  StreamCompleteResult,
  ToolUseOpts,
  ToolUseProviderResult,
  ValidateKeyResult,
  VisionOpts,
  VisionProviderResult,
} from "./types";
import {
  RelayError,
  type RelayClientConfig,
  type RelayDispatchResponse,
  dispatchToRelay,
  readRelayConfigFromEnv,
} from "./relay";

// Dispatch core inspects error messages to decide whether to fall back.
// The strings below MATCH the patterns in dispatch.ts → shouldFallback().
// Keep them exact: "sidecar-offline", "sidecar-timeout", "sidecar-disconnect".
const SIDECAR_ERR_PREFIX = "sidecar";

// ── Workspace context plumbing ─────────────────────────────────────────────
//
// The CompleteOpts shape passed to providers does not carry workspace
// context, so dispatch.ts sets the active user_id via
// `setActiveSidecarUser(...)` immediately before invoking this adapter
// and clears it after. Synchronous set/get is fine because each dispatch
// runs exactly one provider call before returning.

let activeUserId: string | null = null;
let configOverride: RelayClientConfig | null = null;

/** Visible for the dispatch core. */
export function setActiveSidecarUser(userId: string | null) {
  activeUserId = userId;
}

/** Visible for tests. Lets unit tests inject a mock fetch / config. */
export function setRelayConfigOverride(cfg: RelayClientConfig | null) {
  configOverride = cfg;
}

function resolveConfig(): RelayClientConfig {
  if (configOverride) return configOverride;
  const fromEnv = readRelayConfigFromEnv();
  if (!fromEnv) {
    throw makeSidecarError(
      "offline",
      "sidecar-offline: RELAY_URL or RELAY_DISPATCH_SECRET not set",
    );
  }
  return fromEnv;
}

function makeSidecarError(
  kind: "offline" | "timeout" | "disconnect",
  msg: string,
): Error & { sidecarKind: string } {
  const e = new Error(msg) as Error & { sidecarKind: string };
  e.sidecarKind = `${SIDECAR_ERR_PREFIX}-${kind}`;
  return e;
}

function relayErrorToSidecarError(err: unknown): Error {
  if (err instanceof RelayError) {
    switch (err.code) {
      case "sidecar-offline":
      case "config-missing":
      case "relay-unreachable":
        return makeSidecarError("offline", `sidecar-offline: ${err.message}`);
      case "sidecar-timeout":
        return makeSidecarError("timeout", `sidecar-timeout: ${err.message}`);
      case "sidecar-disconnect":
        return makeSidecarError(
          "disconnect",
          `sidecar-disconnect: ${err.message}`,
        );
      case "relay-auth-failed":
        // Misconfigured RELAY_DISPATCH_SECRET — treat as offline so the
        // router falls back to cloud. Operator alert lives in /admin/ops.
        return makeSidecarError(
          "offline",
          `sidecar-offline: relay rejected dispatch secret`,
        );
      case "bad-response":
      default:
        return makeSidecarError(
          "offline",
          `sidecar-offline: ${err.message}`,
        );
    }
  }
  return makeSidecarError(
    "offline",
    `sidecar-offline: ${err instanceof Error ? err.message : String(err)}`,
  );
}

function requireUser(): string {
  const u = activeUserId;
  if (!u) {
    throw makeSidecarError(
      "offline",
      "sidecar-offline: no active user_id in workspace context",
    );
  }
  return u;
}

// Last successful relay response receipt — held briefly so the dispatch
// core can pull the user-signed receipt out for persistence. Cleared
// after each take to avoid cross-request leakage.
let lastResponseReceipt: unknown = null;

/** Visible for the dispatch core + tests. Returns null when no receipt rode along. */
export function takeLastUserSidecarReceipt(): unknown {
  const r = lastResponseReceipt;
  lastResponseReceipt = null;
  return r;
}

// ── Adapter functions ──────────────────────────────────────────────────────
//
// The relay carries an opaque payload. We pass the relevant bits through
// — the sidecar's prompt template does the actual model work. Phase 3
// (S3) will narrow the payload shape per task; for S2 the relay is
// task-blind and the sidecar's stub responds with `{ stub: true }`.

function buildRelayPayload(
  task: string,
  shape:
    | { kind: "complete"; opts: CompleteOpts }
    | { kind: "tool-use"; opts: ToolUseOpts }
    | { kind: "vision"; opts: VisionOpts },
): unknown {
  // Strip apiKey before sending to relay. The sidecar uses LOCAL models
  // — the user's cloud key has no business crossing the relay. Aligns
  // with §4.5: relay sees no payload secrets.
  switch (shape.kind) {
    case "complete":
      return {
        kind: "complete",
        task,
        systemPrompt: shape.opts.systemPrompt,
        messages: shape.opts.messages,
        maxTokens: shape.opts.maxTokens,
        model: shape.opts.model,
        temperature: shape.opts.temperature,
        jsonMode: shape.opts.jsonMode,
      };
    case "tool-use":
      return {
        kind: "tool-use",
        task,
        systemPrompt: shape.opts.systemPrompt,
        messages: shape.opts.messages,
        tools: shape.opts.tools,
        maxTokens: shape.opts.maxTokens,
        model: shape.opts.model,
        temperature: shape.opts.temperature,
      };
    case "vision":
      return {
        kind: "vision",
        task,
        systemPrompt: shape.opts.systemPrompt,
        message: shape.opts.message,
        maxTokens: shape.opts.maxTokens,
        model: shape.opts.model,
      };
  }
}

async function doRelayDispatch(
  task: string,
  payload: unknown,
  timeoutMs?: number,
): Promise<RelayDispatchResponse> {
  const userId = requireUser();
  const cfg = resolveConfig();
  let res: RelayDispatchResponse;
  try {
    res = await dispatchToRelay(cfg, {
      userId,
      task,
      payload,
      timeoutMs: timeoutMs ?? 2_000,
    });
  } catch (err) {
    throw relayErrorToSidecarError(err);
  }
  if (res.status !== "ok") {
    throw makeSidecarError(
      "offline",
      `sidecar-offline: ${res.error ?? "sidecar reported error"}`,
    );
  }
  lastResponseReceipt = res.receipt ?? null;
  return res;
}

export async function complete(opts: CompleteOpts): Promise<AIResponse> {
  // Task is not exposed to providers in S1's interface. We default to a
  // generic tag — S3 will plumb the task name through so per-task prompt
  // templates can pick the right model on the sidecar.
  const task = "user-sidecar/complete";
  const res = await doRelayDispatch(
    task,
    buildRelayPayload(task, { kind: "complete", opts }),
    opts.timeout,
  );
  // Sidecar response body shape (S2 stub vs S3 real) — accept either:
  //   { text, usage, model }                          — S3 real
  //   { stub: true, task, note }                      — S2 placeholder
  const body = (res.body ?? {}) as Record<string, unknown>;
  if (body.stub === true) {
    return {
      text: typeof body.note === "string" ? body.note : "",
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      model: typeof body.model === "string" ? body.model : "user-sidecar-stub",
      provider: "openai", // placeholder; provider taxonomy expands in S3
    };
  }
  return {
    text: typeof body.text === "string" ? body.text : "",
    usage: {
      inputTokens: numField(body, "inputTokens"),
      outputTokens: numField(body, "outputTokens"),
      cachedInputTokens: numField(body, "cachedInputTokens"),
    },
    model: typeof body.model === "string" ? body.model : "user-sidecar",
    provider: "openai",
  };
}

export async function withTools(
  _opts: ToolUseOpts,
): Promise<ToolUseProviderResult> {
  // Per architecture §5.1 — tool-use code.* tasks are CLOUD-only. They
  // never resolve to user-sidecar today. Treat as offline so the router
  // falls back gracefully if a future rule misfires.
  throw makeSidecarError(
    "offline",
    "sidecar-offline: tool-use tasks are cloud-only per architecture §5.1",
  );
}

export async function vision(_opts: VisionOpts): Promise<VisionProviderResult> {
  throw makeSidecarError(
    "offline",
    "sidecar-offline: vision tasks are cloud-only in v0.3",
  );
}

export async function* streamComplete(
  _opts: StreamCompleteOpts,
): StreamCompleteResult {
  // v0.3 S2.5: streaming over the relay isn't wired yet. Throw the
  // sentinel so dispatchStream() falls back to non-streaming complete()
  // (which goes through the relay /dispatch path) and emits a single chunk.
  throw new Error(
    "stream-not-supported: user-sidecar streaming arrives in S3+ when relay carries SSE frames",
  );
  // Generator marker so the function type matches; never reached.
  yield { type: "final", final: { usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, model: "" } };
}

export async function validateKey(_apiKey: string): Promise<ValidateKeyResult> {
  // user-sidecar is reachable via WS relay, not an API key. Settings → AI Keys
  // never hits this path; surface a clear error if it ever does.
  return {
    valid: false,
    error: "user-sidecar is not a key-authenticated provider",
  };
}

function numField(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
