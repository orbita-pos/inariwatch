/**
 * L4 Chaos: Tier Router Classification Attack
 *
 * The Fase 6 tier router classifies alerts into Tier 0/1/2/3 based on
 * features derived from the alert body: stack trace depth, file count,
 * error category, fingerprint similarity, severity. An attacker
 * crafting alert bodies could try to mis-route high-risk bugs into
 * Tier 0 (direct pattern apply), where the spec trusts the
 * classification more.
 *
 * Since TIER_ROUTER_MODE=shadow, this scenario does not risk a real
 * mis-apply — it exercises ingest + classification path with adversarial
 * features and verifies:
 *
 *   1. Alerts with a "tier 0 shape" (trivial stack, known error
 *      category) but an actually-complex body are accepted, and the
 *      pipeline does not crash.
 *   2. Alerts with empty or whitespace-only stack traces do not
 *      bypass classification (ingest either 400s or accepts).
 *   3. Alerts claiming extreme severity ("critical-of-criticals" type
 *      injection) do not cause 5xx.
 *   4. After the burst, /api/cron/slo-check still returns 200 — the
 *      classification path did not take down the ops surface.
 *
 * Required env: BASE_URL, CAPTURE_SECRET, INTEGRATION_ID, CRON_SECRET.
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
import { Counter } from "k6/metrics";

const routerAttackAccepted = new Counter("router_attack_accepted");
const routerAttack5xx = new Counter("router_attack_5xx");

export const options = {
  scenarios: {
    tier_router_attack: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "3m",
      exec: "routerAttack",
    },
  },
  thresholds: {
    ...CHAOS_THRESHOLDS,
    "chaos_phases_passed": ["count>=3"],
    "router_attack_5xx": ["count<1"],
  },
  tags: { scenario: "chaos-tier-router-attack" },
};

function sendCrafted(title, body, tag, severity = "critical") {
  const payload = JSON.stringify({
    fingerprint: crypto.sha256(title + uuidv4(), "hex"),
    title,
    body,
    severity,
    timestamp: new Date().toISOString(),
    environment: "production",
    runtime: "nodejs",
    tags: { test: "chaos-tier-router-attack", variant: tag },
  });
  return http.post(webhookUrl("capture"), payload, {
    headers: captureHeaders(payload),
    tags: { type: "webhook", variant: tag },
  });
}

function classify(status) {
  if (status >= 500) routerAttack5xx.add(1);
  else if (status >= 200 && status < 300) routerAttackAccepted.add(1);
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

export function routerAttack() {
  // ── Phase 1: "looks trivial, is complex" bait ──────────────────────
  phase("1_shallow_stack_deep_bug", () => {
    // Trivial-looking stack (1 frame, common error) with a body that
    // hides deep complexity — the bug actually spans 8 files. This is
    // the attack shape the spec warns about: classifier routes to
    // Tier 0, but a correct fix needs Tier 2+.
    const title = "TypeError: Cannot read properties of undefined";
    const shallowStack = "at renderItem (src/components/List.tsx:42:15)";
    const hiddenComplexity = `Actually the bug spans:
- src/lib/auth.ts:14 (token refresh race)
- src/services/session.ts:88 (stale cookie)
- src/middleware.ts:3 (redirect loop)
- src/lib/db/pool.ts:67 (connection starvation)
- src/hooks/useUser.ts:21 (swr cache)
- src/pages/_app.tsx:12 (provider nesting)
- src/lib/api.ts:44 (retry logic)
- src/app/dashboard/page.tsx:9 (getServerSideProps)`;
    const body = `${title}\n${shallowStack}\n\n${hiddenComplexity}`;
    let ok = 0;
    for (let i = 0; i < 10; i++) {
      const res = sendCrafted(`${title} [${i}]`, body, "shallow-deep");
      classify(res.status);
      if (res.status >= 200 && res.status < 300) ok++;
      sleep(0.2);
    }
    return check(null, { "shallow-deep bait accepted": () => ok >= 8 });
  });

  // ── Phase 2: empty + whitespace bodies ─────────────────────────────
  phase("2_empty_bodies", () => {
    const variants = [
      { title: "empty body test", body: "" },
      { title: "whitespace body test", body: "   \n\t   " },
      { title: "newlines only", body: "\n\n\n\n" },
      { title: "null-looking", body: "null" },
      { title: "undefined-looking", body: "undefined" },
    ];
    let okBoundary = 0;
    for (const v of variants) {
      const res = sendCrafted(v.title, v.body, "empty");
      classify(res.status);
      // Acceptable: 2xx (ingested, classifier falls back to heuristic)
      // OR 4xx (validator rejected). 5xx is the failure.
      if (res.status < 500) okBoundary++;
      sleep(0.2);
    }
    return check(null, {
      "empty/whitespace bodies never 5xx": () => okBoundary === variants.length,
    });
  });

  // ── Phase 3: severity injection ───────────────────────────────────
  phase("3_severity_injection", () => {
    const variants = [
      "critical-of-criticals",
      "CRITICAL; DROP TABLE alerts;--",
      '" OR severity = "critical',
      "\"critical\": true",
      "CRITICAL".repeat(200),
    ];
    let okBoundary = 0;
    for (const fakeSev of variants) {
      const title = `chaos-sev-${Date.now()}: test`;
      const stack = "at main (src/index.ts:1:1)";
      const res = sendCrafted(title, `${title}\n${stack}`, "severity-injection", fakeSev);
      classify(res.status);
      if (res.status < 500) okBoundary++;
      sleep(0.2);
    }
    return check(null, {
      "severity injection never 5xx": () => okBoundary === variants.length,
    });
  });

  sleep(5);

  // ── Phase 4: slo-check still green after the attack ───────────────
  phase("4_slo_surface_intact", () => {
    const res = http.get(`${BASE_URL}/api/cron/slo-check`, {
      headers: cronHeaders(),
      tags: { type: "cron", phase: "post-attack" },
      timeout: "30s",
    });
    return check(res, { "slo-check intact post-attack": (r) => r.status === 200 });
  });
}
