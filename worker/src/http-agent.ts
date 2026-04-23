/**
 * Fase 3 — HTTP keep-alive dispatcher for the worker's AI provider calls.
 *
 * Mirrors web/lib/ai/http-agent.ts. See that file for the full rationale.
 *
 * Worker is a long-running Node.js process on Hetzner, not a serverless
 * Lambda, so the keep-alive benefit is even larger here: the same process
 * serves thousands of remediation turns, and without a shared agent every
 * OpenAI call repays the TLS handshake (~80ms to the California region).
 *
 * Kill switch: `REMEDIATION_MODEL_ROUTING=false` (the Fase 3 umbrella flag).
 * When the flag is off, `installKeepAliveDispatcher()` is a no-op.
 *
 * Idempotent.
 */

import { Agent, setGlobalDispatcher } from "undici";

let installed = false;

export function isModelRoutingEnabled(): boolean {
  return process.env.REMEDIATION_MODEL_ROUTING === "true";
}

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

export function resetForTests(): void {
  installed = false;
}
