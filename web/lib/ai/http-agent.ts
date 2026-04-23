/**
 * Fase 3 — HTTP keep-alive dispatcher for AI provider calls.
 *
 * Node's default global `fetch` dispatcher closes TLS connections after
 * every request. Each Responses API / Anthropic / Groq call therefore pays
 * the TCP + TLS handshake again (~80-150ms on a warm Vercel Lambda, more
 * from other regions). A single remediation can burn 3-5s just on handshakes.
 *
 * An `undici.Agent` with `keepAliveTimeout: 30_000` reuses the socket across
 * calls within a 30s window. On a long remediation that's a direct TTFT win
 * on every turn after the first.
 *
 * Tuning per the Fase 3 spec in REMEDIATION_SYSTEM_ARCHITECTURE.md §4:
 *   - connections: 32 — cap idle sockets per origin; matches expected
 *     parallel-tool fanout in Fase 7 (N=5 sub-agents × 5-6 concurrent
 *     provider calls + headroom)
 *   - pipelining: 1 — HTTP/1.1 pipelining is unreliable with streaming /
 *     reasoning responses; keep it off
 *   - keepAliveTimeout: 30_000 — long enough to span a multi-turn remediation
 *     but short enough that an idle Lambda drops sockets before the runtime
 *     tears down
 *
 * Kill switch: `REMEDIATION_MODEL_ROUTING=false` (the Fase 3 umbrella flag).
 * When the flag is off, `installKeepAliveDispatcher()` is a no-op and the
 * default Node dispatcher stays in place — exactly the current behavior.
 *
 * Idempotent. Safe to call from multiple modules; only the first call wins.
 */

import { Agent, setGlobalDispatcher } from "undici";

let installed = false;

export function isModelRoutingEnabled(): boolean {
  return process.env.REMEDIATION_MODEL_ROUTING === "true";
}

/**
 * Install the keep-alive dispatcher once per process. Reads the flag at
 * call time (not import time) so test suites can flip it per-test.
 */
export function installKeepAliveDispatcher(): void {
  if (installed) return;
  if (!isModelRoutingEnabled()) return;

  const agent = new Agent({
    connections: 32,
    pipelining: 1,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  });
  setGlobalDispatcher(agent);
  installed = true;
}

/**
 * Test-only hook: drops the installed flag so a follow-up call can
 * re-install with a different flag value. Does NOT uninstall the current
 * dispatcher — use `setGlobalDispatcher(new Agent())` in the test if a
 * full reset is needed.
 */
export function resetForTests(): void {
  installed = false;
}
