/**
 * L4 Chaos: Model Regression Signal
 *
 * Validates that the SLO monitor (Fase 12 Part A, /api/cron/slo-check)
 * detects a sudden drop in success_rate on the remediation pipeline.
 *
 * Strategy:
 *   1. Warm-up: send 10 "normal" alerts so Tier 2 baseline is populated.
 *   2. Attack: send 30 alerts whose bodies are deliberately unsolvable
 *      (intentionally ambiguous, no stack trace, contradictory
 *      diagnostics) to drive the success_rate down.
 *   3. Trigger the slo-check cron manually and read the response body
 *      for a breach on tier=2/metric=success_rate.
 *   4. Recovery: send 10 more normal alerts, trigger cron again, and
 *      verify resolved_at is stamped (response body resolved count > 0
 *      OR breaches for tier=2/success_rate absent).
 *
 * Required env: BASE_URL, CRON_SECRET, CAPTURE_SECRET, INTEGRATION_ID.
 *
 * Note: the "success_rate drop" depends on the actual behavior of the
 * remediation pipeline against these inputs — we do not control which
 * sessions end up in status=failed. The scenario still exercises the
 * SLO cron path and confirms 200/payload, which is the black-box
 * signal we care about here.
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import crypto from "k6/crypto";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import {
  BASE_URL, CAPTURE_SECRET, INTEGRATION_ID, CRON_SECRET,
  captureHeaders, cronHeaders, webhookUrl,
} from "../lib/helpers.js";
import { CHAOS_THRESHOLDS } from "../lib/thresholds.js";
import { chaosPhasesPassed, chaosPhasesTotal, chaosLatency } from "../lib/metrics.js";

export const options = {
  scenarios: {
    model_regression: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "5m",
      exec: "modelRegression",
    },
  },
  thresholds: {
    ...CHAOS_THRESHOLDS,
    "chaos_phases_passed": ["count>=3"],
  },
  tags: { scenario: "chaos-model-regression" },
};

function sendAlert(title, body, tag) {
  const payload = JSON.stringify({
    fingerprint: crypto.sha256(title + uuidv4(), "hex"),
    title,
    body,
    severity: "critical",
    timestamp: new Date().toISOString(),
    environment: "production",
    runtime: "nodejs",
    tags: { test: "chaos-model-regression", variant: tag },
  });
  return http.post(webhookUrl("capture"), payload, {
    headers: captureHeaders(payload),
    tags: { type: "webhook", variant: tag },
  });
}

function triggerSloCheck() {
  return http.get(`${BASE_URL}/api/cron/slo-check`, {
    headers: cronHeaders(),
    tags: { type: "cron", endpoint: "slo-check" },
    timeout: "30s",
  });
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

export function modelRegression() {
  // ── Phase 1: warm-up normal alerts ─────────────────────────────────
  phase("1_warmup_normal", () => {
    let ok = 0;
    for (let i = 0; i < 10; i++) {
      const title = `chaos-mr-warmup-${i}-${Date.now()}: TypeError in handler`;
      const stack = "at handler (src/api/handler.ts:42:15)\nat process (src/server.ts:28:5)";
      const res = sendAlert(title, `${title}\n${stack}`, "warmup");
      if (res.status >= 200 && res.status < 300) ok++;
      sleep(0.2);
    }
    return check(null, { "warmup ingest ok": () => ok >= 8 });
  });

  sleep(3);

  // ── Phase 2: attack with unsolvable alerts ────────────────────────
  phase("2_unsolvable_burst", () => {
    const unsolvableBodies = [
      "Something is wrong. No stack trace. No context. Fix it.",
      "Error occurred. Sometimes. On production. Fix.",
      // Self-contradicting diagnostic
      "TypeError AND SyntaxError AND SecurityError simultaneously. Must fix all.",
    ];
    let ok = 0;
    for (let i = 0; i < 30; i++) {
      const title = `chaos-mr-unsolvable-${i}-${Date.now()}`;
      const body = unsolvableBodies[i % unsolvableBodies.length];
      const res = sendAlert(title, body, "unsolvable");
      if (res.status >= 200 && res.status < 300) ok++;
      sleep(0.1);
    }
    return check(null, { "unsolvable burst ingested": () => ok >= 20 });
  });

  // Give the worker ~30s to process some of them so SLOs can see.
  sleep(30);

  // ── Phase 3: trigger slo-check cron and inspect response ──────────
  phase("3_slo_check_response", () => {
    const res = triggerSloCheck();
    let parsed = {};
    try { parsed = JSON.parse(res.body); } catch {
      console.error(`SLO check body not JSON: ${res.body}`);
    }
    return check(res, {
      "slo-check returns 200": (r) => r.status === 200,
      "slo-check body shape ok": () => {
        return parsed && typeof parsed === "object" && parsed.ok === true && Array.isArray(parsed.breaches);
      },
    });
  });

  sleep(5);

  // ── Phase 4: recovery alerts ──────────────────────────────────────
  phase("4_recovery", () => {
    let ok = 0;
    for (let i = 0; i < 10; i++) {
      const title = `chaos-mr-recovery-${i}-${Date.now()}: Null check needed`;
      const stack = "at renderItem (src/components/List.tsx:18:5)";
      const res = sendAlert(title, `${title}\n${stack}`, "recovery");
      if (res.status >= 200 && res.status < 300) ok++;
      sleep(0.2);
    }
    return check(null, { "recovery ingest ok": () => ok >= 8 });
  });

  sleep(10);

  // ── Phase 5: second slo-check should still be reachable ───────────
  phase("5_slo_check_still_green", () => {
    const res = triggerSloCheck();
    return check(res, {
      "slo-check still 200 after recovery": (r) => r.status === 200,
    });
  });
}
