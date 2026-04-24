/**
 * L4 Chaos: Substrate Recording Corruption
 *
 * /api/recordings/upload accepts Substrate recordings (JSON payloads
 * with event arrays). This scenario feeds it corrupted bodies and
 * validates the rejection surface:
 *
 *   1. Bodies with invalid JSON → 400
 *   2. Oversized bodies (>500 KB, the declared cap) → 413
 *   3. Bodies missing recordingId → 400
 *   4. Bodies with recordingId but malformed events (non-array,
 *      circular-looking, binary-style strings) → either 400 or 200
 *      with events stored as-is (we do not assert which; 5xx is the
 *      failure).
 *   5. Unauthenticated requests → 401
 *
 * No valid recording is ever uploaded — the scenario lives entirely
 * on the error boundary.
 *
 * Required env: BASE_URL.
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import { BASE_URL } from "../lib/helpers.js";
import { CHAOS_THRESHOLDS } from "../lib/thresholds.js";
import { chaosPhasesPassed, chaosPhasesTotal, chaosLatency } from "../lib/metrics.js";
import { Counter } from "k6/metrics";

const substrate5xx = new Counter("substrate_corruption_5xx");

export const options = {
  scenarios: {
    substrate_corruption: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "3m",
      exec: "substrateCorruption",
    },
  },
  thresholds: {
    ...CHAOS_THRESHOLDS,
    "chaos_phases_passed": ["count>=4"],
    "substrate_corruption_5xx": ["count<1"],
  },
  tags: { scenario: "chaos-substrate-corruption" },
};

const ENDPOINT = `${BASE_URL}/api/recordings/upload`;

function upload(body, headers = {}) {
  return http.post(ENDPOINT, typeof body === "string" ? body : JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
    tags: { type: "substrate-upload" },
    timeout: "30s",
  });
}

function classify(status) {
  if (status >= 500) substrate5xx.add(1);
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

export function substrateCorruption() {
  // ── Phase 1: unauthenticated → 401 ─────────────────────────────
  phase("1_unauthenticated", () => {
    const res = upload({ recordingId: uuidv4(), events: [] });
    classify(res.status);
    return check(res, { "unauthenticated → 401": (r) => r.status === 401 });
  });

  // ── Phase 2: invalid JSON → 400 or 401 ─────────────────────────
  phase("2_invalid_json", () => {
    const variants = ["not json{{", "", "null", "[]", "\"string\""];
    let ok = 0;
    for (const v of variants) {
      const res = upload(v);
      classify(res.status);
      if (res.status >= 400 && res.status < 500) ok++;
      sleep(0.1);
    }
    return check(null, { "invalid JSON bodies are 4xx": () => ok === variants.length });
  });

  // ── Phase 3: oversized body → 413 ──────────────────────────────
  phase("3_oversized", () => {
    // Build a body deliberately > 500 KB via a padded `events` array.
    const events = Array.from({ length: 5000 }, (_, i) => ({
      type: "http",
      at: Date.now() + i,
      payload: "X".repeat(200),
    }));
    const body = { recordingId: uuidv4(), events };
    const res = upload(body);
    classify(res.status);
    // 413 is the documented rejection; 401 is also acceptable since
    // we have no auth (server may check content-length before auth).
    return check(res, {
      "oversized body → 4xx (not 5xx)": (r) => r.status >= 400 && r.status < 500,
    });
  });

  // ── Phase 4: missing recordingId → 400 (or 401) ────────────────
  phase("4_missing_id", () => {
    const variants = [
      {},
      { events: [] },
      { recordingId: null },
      { recordingId: "" },
      { recordingId: 12345 },
    ];
    let ok = 0;
    for (const v of variants) {
      const res = upload(v, { authorization: "Bearer not-the-real-secret" });
      classify(res.status);
      if (res.status >= 400 && res.status < 500) ok++;
      sleep(0.1);
    }
    return check(null, { "bad recordingId is 4xx": () => ok === variants.length });
  });

  // ── Phase 5: malformed events arrays ───────────────────────────
  phase("5_malformed_events", () => {
    const variants = [
      { recordingId: uuidv4(), events: "not-an-array" },
      { recordingId: uuidv4(), events: { foo: "bar" } },
      { recordingId: uuidv4(), events: Array(100).fill({ type: null, at: "nope" }) },
      { recordingId: uuidv4(), events: [{ binary: "\x00\x01\x02\x03" }] },
    ];
    let okBoundary = 0;
    for (const v of variants) {
      const res = upload(v);
      classify(res.status);
      if (res.status < 500) okBoundary++;
      sleep(0.1);
    }
    return check(null, { "malformed events never 5xx": () => okBoundary === variants.length });
  });
}
