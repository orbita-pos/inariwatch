/**
 * Chaos engineering — fault injection primitives.
 *
 * Patches globalThis.fetch to simulate real failure modes:
 * network errors, HTTP status overrides, latency, garbage responses.
 *
 * Usage:
 *   await withFaultyFetch({ statusOverride: 500, urlPattern: providerUrl("claude") }, async () => {
 *     await callAI(...); // will get a 500
 *   });
 */

export interface FaultOpts {
  /** Probability (0-1) that fetch throws a network error */
  failRate?: number;
  /** Force this HTTP status on all (matched) responses */
  statusOverride?: number;
  /** Artificial delay in ms before fetch resolves */
  latencyMs?: number;
  /** Only apply faults to URLs matching this regex */
  urlPattern?: RegExp;
  /** Override response body (string or object → JSON) */
  responseBody?: string | Record<string, unknown>;
  /** Response headers to include */
  responseHeaders?: Record<string, string>;
  /** Call counter — incremented on each matched fetch */
  callLog?: { count: number };
  /** If set, only fail the first N calls then let through */
  failFirstN?: number;
}

const PROVIDER_URLS: Record<string, RegExp> = {
  claude: /api\.anthropic\.com/,
  openai: /api\.openai\.com/,
  gemini: /generativelanguage\.googleapis\.com/,
  grok: /api\.x\.ai/,
  groq: /api\.groq\.com/,
  deepseek: /api\.deepseek\.com/,
  slack: /slack\.com\/api/,
  telegram: /api\.telegram\.org/,
  sentry: /sentry\.io/,
  vercel: /api\.vercel\.com/,
  github: /api\.github\.com/,
  resend: /api\.resend\.com/,
};

/** Get a URL pattern regex for a known provider/service */
export function providerUrl(name: keyof typeof PROVIDER_URLS): RegExp {
  return PROVIDER_URLS[name];
}

/**
 * Run `fn` with a patched global fetch that injects faults.
 * Original fetch is always restored, even on error.
 */
export async function withFaultyFetch<T>(
  opts: FaultOpts,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  let matchedCalls = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Skip faults for non-matching URLs
    if (opts.urlPattern && !opts.urlPattern.test(url)) {
      return originalFetch(input, init);
    }

    matchedCalls++;
    if (opts.callLog) opts.callLog.count++;

    // failFirstN: let through after N failures
    if (opts.failFirstN !== undefined && matchedCalls > opts.failFirstN) {
      return originalFetch(input, init);
    }

    // Artificial latency
    if (opts.latencyMs) {
      await new Promise((r) => setTimeout(r, opts.latencyMs));
    }

    // Network failure (random or deterministic)
    if (opts.failRate !== undefined) {
      if (opts.failRate >= 1 || Math.random() < opts.failRate) {
        throw new TypeError("fetch failed (chaos: network error)");
      }
    }

    // HTTP status override with custom body
    if (opts.statusOverride !== undefined) {
      const body =
        opts.responseBody !== undefined
          ? typeof opts.responseBody === "string"
            ? opts.responseBody
            : JSON.stringify(opts.responseBody)
          : `{"error":"chaos: forced ${opts.statusOverride}"}`;

      return new Response(body, {
        status: opts.statusOverride,
        statusText: `Chaos ${opts.statusOverride}`,
        headers: {
          "Content-Type": "application/json",
          ...opts.responseHeaders,
        },
      });
    }

    // Response body override (keep status 200)
    if (opts.responseBody !== undefined) {
      const body =
        typeof opts.responseBody === "string"
          ? opts.responseBody
          : JSON.stringify(opts.responseBody);
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json", ...opts.responseHeaders },
      });
    }

    // No fault conditions matched — pass through
    return originalFetch(input, init);
  };

  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/**
 * Fire `fn` N times in parallel. Returns all settled results.
 * Useful for testing race conditions (dedup, concurrency).
 */
export async function racingCalls<T>(
  count: number,
  fn: () => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(Array.from({ length: count }, () => fn()));
}
