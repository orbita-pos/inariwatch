// Relay HTTP helper. v0.3 S2.
//
// Used by the user-sidecar provider to reach `relay.inariwatch.com`'s
// /dispatch endpoint. Server-to-server bearer auth with
// `RELAY_DISPATCH_SECRET` (shared with the Go relay).
//
// Per INARI_AI_ARCHITECTURE.md §4 — relay is the only piece of new infra
// the architecture requires. This helper hides the HTTP shape so the
// user-sidecar provider stays a simple translator from CompleteOpts /
// ToolUseOpts → relay frame body.

const DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_BACKOFF_MS = 100;

export interface RelayDispatchRequest {
  userId: string;
  task: string;
  payload: unknown;
  timeoutMs?: number;
}

export interface RelayDispatchResponse {
  requestId: string;
  userId: string;
  task: string;
  status: "ok" | "error";
  body?: unknown;
  receipt?: unknown;
  error?: string;
}

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly httpStatus?: number;
  constructor(code: RelayErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type RelayErrorCode =
  | "config-missing"
  | "sidecar-offline"
  | "sidecar-timeout"
  | "sidecar-disconnect"
  | "relay-unreachable"
  | "relay-auth-failed"
  | "bad-response";

export interface RelayClientConfig {
  /** Public origin, e.g. https://relay.inariwatch.com. */
  baseUrl: string;
  /** Server-to-server shared secret. */
  dispatchSecret: string;
  /** Override for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Reads relay config from process env. Centralised so the user-sidecar
 * provider doesn't have to repeat the env-var dance in tests.
 */
export function readRelayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RelayClientConfig | null {
  const baseUrl = env.RELAY_URL;
  const dispatchSecret = env.RELAY_DISPATCH_SECRET;
  if (!baseUrl || !dispatchSecret) return null;
  return { baseUrl, dispatchSecret };
}

/**
 * POSTs to the relay's /dispatch endpoint, retrying once on transient
 * network failure. Maps relay's HTTP status codes to RelayError codes
 * the dispatch core can match against rule.fallbackTriggers.
 */
export async function dispatchToRelay(
  cfg: RelayClientConfig,
  req: RelayDispatchRequest,
): Promise<RelayDispatchResponse> {
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new RelayError(
      "config-missing",
      "no fetch implementation available — set globalThis.fetch or pass cfg.fetchImpl",
    );
  }
  const url = trimTrailingSlash(cfg.baseUrl) + "/dispatch";
  const body = JSON.stringify({
    user_id: req.userId,
    task: req.task,
    payload: req.payload ?? null,
    timeout_ms: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    Math.max(1, (req.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 250),
  );
  let lastNetworkErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.dispatchSecret}`,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeoutHandle);
      return await mapResponse(res);
    } catch (err) {
      lastNetworkErr = err;
      if (attempt === 0) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
    }
  }
  clearTimeout(timeoutHandle);
  if (
    lastNetworkErr instanceof Error &&
    /aborted|signal/i.test(lastNetworkErr.message)
  ) {
    throw new RelayError(
      "sidecar-timeout",
      "relay request timed out before response",
    );
  }
  throw new RelayError(
    "relay-unreachable",
    `relay unreachable: ${
      lastNetworkErr instanceof Error
        ? lastNetworkErr.message
        : String(lastNetworkErr)
    }`,
  );
}

async function mapResponse(res: Response): Promise<RelayDispatchResponse> {
  let parsed: Partial<RelayDispatchResponse> & { error?: string } = {};
  try {
    parsed = (await res.json()) as Partial<RelayDispatchResponse>;
  } catch {
    if (res.status === 200) {
      throw new RelayError(
        "bad-response",
        `relay returned 200 with non-JSON body`,
        res.status,
      );
    }
    parsed = {};
  }
  if (res.status === 200) {
    return {
      requestId: parsed.requestId ?? "",
      userId: parsed.userId ?? "",
      task: parsed.task ?? "",
      status: parsed.status === "error" ? "error" : "ok",
      body: parsed.body,
      receipt: parsed.receipt,
      error: parsed.error,
    };
  }
  if (res.status === 401) {
    throw new RelayError(
      "relay-auth-failed",
      "RELAY_DISPATCH_SECRET rejected by relay",
      401,
    );
  }
  if (res.status === 503) {
    const code: RelayErrorCode =
      parsed.error === "sidecar-disconnect"
        ? "sidecar-disconnect"
        : "sidecar-offline";
    throw new RelayError(code, `relay 503: ${parsed.error ?? "unavailable"}`, 503);
  }
  if (res.status === 504) {
    throw new RelayError(
      "sidecar-timeout",
      `relay 504: ${parsed.error ?? "timeout"}`,
      504,
    );
  }
  throw new RelayError(
    "bad-response",
    `relay returned ${res.status}: ${parsed.error ?? "(no body)"}`,
    res.status,
  );
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
