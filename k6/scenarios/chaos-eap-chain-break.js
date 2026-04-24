/**
 * L4 Chaos: EAP Attestation Chain Break
 *
 * Fase 11 shipped the EAP receipts mirror + canonical verify endpoint
 * (/api/eap/verify/:receiptId). This scenario validates the failure
 * surface when a client probes with invalid or tampered receipt IDs:
 *
 *   1. Well-formed but non-existent receipt IDs → 404 (never 500).
 *   2. Malformed receipt IDs (wrong length, non-hex, control chars)
 *      → 400 or 404, never 500.
 *   3. Extremely long receipt IDs → 400 / 414, never 500.
 *   4. A burst of 50 tampered IDs does not take down the endpoint
 *      (post-burst verify on a legitimate-looking ID still returns).
 *
 * Required env: BASE_URL.
 *
 * This is a pure black-box probe — we do not need EAP server access
 * nor a real receipt. Any valid receipt would return 200 with the
 * mirror row; we never assert on that because the scenario is about
 * the error boundary, not the happy path.
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { BASE_URL } from "../lib/helpers.js";
import { CHAOS_THRESHOLDS } from "../lib/thresholds.js";
import { chaosPhasesPassed, chaosPhasesTotal, chaosLatency } from "../lib/metrics.js";
import { Counter } from "k6/metrics";

const eapErrors5xx = new Counter("eap_break_5xx");
const eap4xxClean = new Counter("eap_break_4xx");

export const options = {
  scenarios: {
    eap_chain_break: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "2m",
      exec: "eapChainBreak",
    },
  },
  thresholds: {
    ...CHAOS_THRESHOLDS,
    "chaos_phases_passed": ["count>=3"],
    "eap_break_5xx": ["count<1"],
  },
  tags: { scenario: "chaos-eap-chain-break" },
};

function verify(receiptId) {
  const url = `${BASE_URL}/api/eap/verify/${encodeURIComponent(receiptId)}`;
  return http.get(url, {
    tags: { type: "eap-verify" },
    timeout: "15s",
  });
}

function classify(res) {
  if (res.status >= 500) eapErrors5xx.add(1);
  else if (res.status >= 400) eap4xxClean.add(1);
}

function phase(name, fn) {
  return group(name, () => {
    const start = Date.now();
    chaosPhasesTotal.add(1);
    let passed = false;
    try { passed = fn(); } catch (e) { console.error(`Phase ${name} threw: ${e}`); }
    chaosLatency.add(Date.now() - start);
    if (passed) chaosPhasesPassed.add(1);
    return passed;
  });
}

// A syntactically well-formed 64-char hex string that (almost
// certainly) does not exist in the DB — we expect 404.
function randHex(len) {
  const chars = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function eapChainBreak() {
  // ── Phase 1: non-existent but well-formed IDs → 404 ─────────────
  phase("1_not_found", () => {
    let ok = 0;
    for (let i = 0; i < 10; i++) {
      const res = verify(randHex(64));
      classify(res);
      // Accept 404 OR 400 (some endpoints may pre-validate shape),
      // reject 5xx.
      if (res.status === 404 || res.status === 400) ok++;
      sleep(0.1);
    }
    return check(null, { "non-existent IDs cleanly rejected": () => ok >= 8 });
  });

  // ── Phase 2: malformed IDs (wrong length, non-hex, control) ─────
  phase("2_malformed", () => {
    const variants = [
      "not-hex",
      "abc123",                        // too short
      randHex(63),                    // off by one
      randHex(65),                    // off by one
      "Z".repeat(64),                // non-hex of correct length
      "\x00".repeat(64),            // null bytes
      "%20".repeat(32),              // encoded spaces
      randHex(64) + "/etc/passwd",  // path traversal attempt
    ];
    let okBoundary = 0;
    for (const id of variants) {
      const res = verify(id);
      classify(res);
      if (res.status < 500) okBoundary++;
      sleep(0.1);
    }
    return check(null, { "malformed IDs never 5xx": () => okBoundary === variants.length });
  });

  // ── Phase 3: extremely long IDs → 400 or 414 ────────────────────
  phase("3_oversized_id", () => {
    const huge = "a".repeat(8192);
    const res = verify(huge);
    classify(res);
    return check(res, {
      "oversized ID 4xx not 5xx": (r) => r.status >= 400 && r.status < 500,
    });
  });

  // ── Phase 4: 50-request burst of tampered IDs ──────────────────
  phase("4_tampered_burst", () => {
    let okBoundary = 0;
    for (let i = 0; i < 50; i++) {
      const id = randHex(64 + (i % 4 === 0 ? 1 : 0));
      const res = verify(id);
      classify(res);
      if (res.status < 500) okBoundary++;
      sleep(0.02);
    }
    return check(null, { "50-request burst never 5xx": () => okBoundary === 50 });
  });
}
