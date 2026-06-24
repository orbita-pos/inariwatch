/**
 * Unit tests for compliance-scan.ts — VAR Gate 15.
 *
 * Tests every rule pattern against positive + negative cases and
 * verifies result aggregation (per-category counts, severity counts,
 * dedup, pass/fail). No network, no DB — pure regex over in-memory
 * strings.
 */

import { describe, it, expect } from "vitest";
import { scanCompliance, COMPLIANCE_RULES } from "../compliance-scan";

function scan(content: string, path = "src/example.ts") {
  return scanCompliance([{ path, content }]);
}

function findingsForRule(result: ReturnType<typeof scan>, rule: string) {
  return result.findings.filter((f) => f.rule === rule);
}

// ── Sanity / catalog shape ────────────────────────────────────────────────

describe("compliance rule catalog", () => {
  it("every rule has a unique id", () => {
    const ids = COMPLIANCE_RULES.map((r) => r.rule);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every rule id is prefixed with its category lowercased", () => {
    for (const r of COMPLIANCE_RULES) {
      expect(r.rule.startsWith(r.category.toLowerCase() + "/")).toBe(true);
    }
  });

  it("catalog covers all three regulations", () => {
    const categories = new Set(COMPLIANCE_RULES.map((r) => r.category));
    expect(categories).toEqual(new Set(["GDPR", "SOC2", "PCI"]));
  });
});

// ── GDPR ──────────────────────────────────────────────────────────────────

describe("GDPR rules", () => {
  it("flags console.log of user.email", () => {
    const r = scan(`console.log("user login", user.email)`);
    expect(findingsForRule(r, "gdpr/pii-in-logs")).toHaveLength(1);
    expect(r.highCount).toBe(1);
  });

  it("flags console.error of ssn/social_security", () => {
    const r = scan(`console.error("invalid social_security number")`);
    expect(findingsForRule(r, "gdpr/pii-in-logs").length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag redacted email in logs", () => {
    const r = scan(`console.log("user login", user.id)`);
    expect(findingsForRule(r, "gdpr/pii-in-logs")).toHaveLength(0);
  });

  it("flags ssn column in plaintext as HIGH", () => {
    const r = scan(`ssn: text("ssn").notNull(),`);
    expect(findingsForRule(r, "gdpr/sensitive-pii-plaintext-column")).toHaveLength(1);
    expect(r.highCount).toBe(1);
  });

  it("flags email column in plaintext as MEDIUM (needs review, not fail)", () => {
    const r = scan(`email: text("email").notNull(),`);
    expect(findingsForRule(r, "gdpr/pii-plaintext-column")).toHaveLength(1);
    expect(r.mediumCount).toBe(1);
    expect(r.highCount).toBe(0);
    expect(r.passed).toBe(true);
  });

  it("flags document.cookie set as MEDIUM (review consent)", () => {
    const r = scan(`document.cookie = "session=abc; path=/"`);
    expect(findingsForRule(r, "gdpr/cookie-set-review-consent")).toHaveLength(1);
    expect(r.passed).toBe(true); // MEDIUM doesn't fail
  });

  it("flags PII interpolated into URL query", () => {
    const r = scan("const u = `https://api.example.com/search?email=${user.email}`");
    expect(findingsForRule(r, "gdpr/pii-in-url-query").length).toBeGreaterThanOrEqual(1);
    expect(r.highCount).toBeGreaterThanOrEqual(1);
  });

  it("flags logging raw req.body", () => {
    const r = scan(`console.log("incoming", req.body)`);
    expect(findingsForRule(r, "gdpr/raw-request-body-log")).toHaveLength(1);
  });

  it("all GDPR findings populate category=GDPR", () => {
    const r = scan(`console.log("ssn:", user.ssn)\nssn: text("ssn"),`);
    for (const f of r.findings) expect(f.category).toBe("GDPR");
    expect(r.gdprCount).toBe(r.findings.length);
  });
});

// ── SOC2 ──────────────────────────────────────────────────────────────────

describe("SOC2 rules", () => {
  it("flags auth: false in config", () => {
    const r = scan(`middleware({ auth: false, cors: true })`);
    expect(findingsForRule(r, "soc2/auth-disabled")).toHaveLength(1);
    expect(r.highCount).toBe(1);
  });

  it("flags requireAuth: false", () => {
    const r = scan(`export const config = { requireAuth: false }`);
    expect(findingsForRule(r, "soc2/auth-disabled")).toHaveLength(1);
  });

  it("flags rejectUnauthorized: false in https/axios config", () => {
    const r = scan(`const client = axios.create({ httpsAgent: new Agent({ rejectUnauthorized: false }) })`);
    expect(findingsForRule(r, "soc2/tls-verification-disabled")).toHaveLength(1);
    expect(r.highCount).toBe(1);
  });

  it("flags secure: false cookie", () => {
    const r = scan(`res.cookie("session", token, { secure: false, httpOnly: true })`);
    expect(findingsForRule(r, "soc2/insecure-cookie-flags")).toHaveLength(1);
    expect(r.mediumCount).toBe(1);
  });

  it("flags rateLimit: false", () => {
    const r = scan(`app.use(router, { rateLimit: false })`);
    expect(findingsForRule(r, "soc2/rate-limit-disabled")).toHaveLength(1);
  });

  it("flags hardcoded admin string check", () => {
    const r = scan(`if (user.role === "admin") return next()`);
    expect(findingsForRule(r, "soc2/hardcoded-admin-check")).toHaveLength(1);
  });

  it("does NOT flag role-based check via RBAC helper", () => {
    const r = scan(`if (hasRole(user, "admin")) return next()`);
    expect(findingsForRule(r, "soc2/hardcoded-admin-check")).toHaveLength(0);
  });

  it("flags CSP unsafe-eval header", () => {
    const r = scan(`headers["Content-Security-Policy"] = "script-src 'self' 'unsafe-eval'"`);
    expect(findingsForRule(r, "soc2/csp-unsafe-eval")).toHaveLength(1);
  });

  it("all SOC2 findings populate category=SOC2", () => {
    const r = scan(`auth: false, rejectUnauthorized: false`);
    for (const f of r.findings) expect(f.category).toBe("SOC2");
    expect(r.soc2Count).toBe(r.findings.length);
  });
});

// ── PCI ───────────────────────────────────────────────────────────────────

describe("PCI rules", () => {
  it("flags console.log of card_number", () => {
    const r = scan(`console.log("charge", card_number, amount)`);
    expect(findingsForRule(r, "pci/card-data-in-logs")).toHaveLength(1);
    expect(r.highCount).toBe(1);
  });

  it("flags console.log of cvv", () => {
    const r = scan(`console.log("cvv check:", cvv)`);
    expect(findingsForRule(r, "pci/card-data-in-logs")).toHaveLength(1);
  });

  it("flags card_number column in plaintext", () => {
    const r = scan(`card_number: text("card_number").notNull(),`);
    expect(findingsForRule(r, "pci/pan-plaintext-column")).toHaveLength(1);
    expect(r.highCount).toBe(1);
  });

  it("flags cvv column (prohibited storage)", () => {
    const r = scan(`cvv: varchar("cvv", { length: 4 }),`);
    expect(findingsForRule(r, "pci/cvv-storage-forbidden")).toHaveLength(1);
    expect(r.highCount).toBe(1);
  });

  it("flags deprecated crypto.createCipher", () => {
    const r = scan(`const cipher = crypto.createCipher("aes-256-cbc", key)`);
    expect(findingsForRule(r, "pci/deprecated-cipher")).toHaveLength(1);
  });

  it("does NOT flag crypto.createCipheriv", () => {
    const r = scan(`const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)`);
    expect(findingsForRule(r, "pci/deprecated-cipher")).toHaveLength(0);
  });

  it("flags fetch to payment endpoint over HTTP", () => {
    const r = scan(`await fetch("http://api.example.com/charge", { body })`);
    expect(findingsForRule(r, "pci/payment-over-http")).toHaveLength(1);
    expect(r.highCount).toBe(1);
  });

  it("does NOT flag HTTPS payment endpoint", () => {
    const r = scan(`await fetch("https://api.example.com/charge", { body })`);
    expect(findingsForRule(r, "pci/payment-over-http")).toHaveLength(0);
  });

  it("does NOT flag localhost HTTP (dev mode)", () => {
    const r = scan(`await fetch("http://localhost:3000/charge", { body })`);
    expect(findingsForRule(r, "pci/payment-over-http")).toHaveLength(0);
  });

  it("all PCI findings populate category=PCI", () => {
    const r = scan(`console.log("cvv:", cvv)\ncvv: text("cvv"),`);
    for (const f of r.findings) expect(f.category).toBe("PCI");
    expect(r.pciCount).toBe(r.findings.length);
  });
});

// ── Result aggregation ────────────────────────────────────────────────────

describe("result aggregation", () => {
  it("returns passed=true on clean code", () => {
    const r = scan(`export function add(a: number, b: number) { return a + b }`);
    expect(r.passed).toBe(true);
    expect(r.totalViolations).toBe(0);
    expect(r.findings).toHaveLength(0);
  });

  it("returns passed=false when any HIGH finding exists", () => {
    const r = scan(`console.log("cvv:", cvv)`);
    expect(r.passed).toBe(false);
    expect(r.highCount).toBe(1);
  });

  it("returns passed=true when only MEDIUM/LOW findings exist", () => {
    const r = scan(`email: text("email"),\ndocument.cookie = "x=1"`);
    expect(r.passed).toBe(true);
    expect(r.highCount).toBe(0);
    expect(r.mediumCount).toBeGreaterThanOrEqual(1);
  });

  it("dedupes same rule firing twice on the same line", () => {
    // Two PCI triggers on the same line shouldn't count twice for the
    // same rule. (pan-plaintext-column has a single regex, so this is
    // more a sanity check on the dedup loop.)
    const r = scan(`card_number: text("card_number").notNull(),`);
    expect(findingsForRule(r, "pci/pan-plaintext-column")).toHaveLength(1);
  });

  it("cross-category findings aggregate correctly", () => {
    const code = `
      console.log("email:", user.email)
      auth: false,
      console.log("cvv:", cvv)
    `;
    const r = scan(code);
    expect(r.gdprCount).toBeGreaterThanOrEqual(1);
    expect(r.soc2Count).toBeGreaterThanOrEqual(1);
    expect(r.pciCount).toBeGreaterThanOrEqual(1);
    expect(r.totalViolations).toBe(r.gdprCount + r.soc2Count + r.pciCount);
  });

  it("skips non-code files (e.g., .md, .json)", () => {
    const md = scanCompliance([{ path: "README.md", content: `console.log("cvv:", cvv)` }]);
    expect(md.findings).toHaveLength(0);
    const json = scanCompliance([{ path: "data.json", content: `{ "cvv": "123" }` }]);
    expect(json.findings).toHaveLength(0);
  });

  it("skips line comments — regulatory rules don't apply to prose", () => {
    const r = scan(`// console.log("cvv:", cvv) — removed for PCI`);
    expect(r.findings).toHaveLength(0);
  });

  it("populates snippet with trimmed line content", () => {
    const r = scan(`    console.log("charge", card_number, amount)    `);
    expect(r.findings[0]!.snippet).toBe(`console.log("charge", card_number, amount)`);
  });

  it("snippet is capped at 200 chars", () => {
    const filler = "x".repeat(500);
    const r = scan(`console.log("cvv:", cvv, "${filler}")`);
    expect(r.findings[0]!.snippet.length).toBeLessThanOrEqual(200);
  });
});
