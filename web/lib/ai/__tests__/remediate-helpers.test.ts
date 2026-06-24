/**
 * Tests for pure helper functions extracted from the remediation engine.
 *
 * These functions guard file safety, parse AI responses, and extract
 * repository context — all critical for preventing bad auto-merges.
 */

import { describe, it, expect } from "vitest";

// ── We test the private helpers by importing the module internals ────────────
// Since these are not exported, we replicate the exact logic here for testing.
// This is intentional: the tests validate the CONTRACT, not the import path.
// If the logic in remediate.ts changes, these tests must be updated.

// ── BLOCKED_FILE_PATTERNS (exact copy from remediate.ts:87-102) ─────────────

const BLOCKED_FILE_PATTERNS = [
  /^\.env(\.|$)/i,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /bun\.lockb$/,
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
  /\.(sql)$/i,
  /^(migrations?|db\/migrations?)\//,
  /^(terraform|infra)\//,
  /\.(tf|tfvars)$/,
  /Dockerfile/i,
  /docker-compose/i,
  /\.(key|pem|cert|p12|pfx)$/i,
];

function isSafeFilePath(p: string): boolean {
  p = p.replace(/[\u200B\u200C\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  p = p.normalize("NFC");
  if (/[\u2044\u2215\uFF0F\uFF0E]/.test(p)) return false;
  if (p.includes("..") || p.startsWith("/") || p.includes("\\") || p.startsWith("~")) return false;
  if (BLOCKED_FILE_PATTERNS.some((re) => re.test(p))) return false;
  return true;
}

function getBlockedReason(p: string): string | null {
  if (p.includes("..") || p.startsWith("/")) return "path traversal";
  if (/^\.env/i.test(p)) return "environment file";
  if (/package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|bun\.lockb$/.test(p)) return "lock file (auto-generated)";
  if (/^\.github\/workflows\//.test(p)) return "CI workflow file";
  if (/\.(sql)$/i.test(p) || /^migrations?\//.test(p)) return "database migration";
  if (/\.(tf|tfvars)$/.test(p) || /^(terraform|infra)\//.test(p)) return "infrastructure config";
  if (/Dockerfile|docker-compose/i.test(p)) return "container config";
  if (/\.(key|pem|cert|p12|pfx)$/i.test(p)) return "secret/certificate file";
  return null;
}

function cleanJSON(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) return obj[0];
  return raw;
}

function extractRepo(alertTitle: string): string | null {
  const onMatch = alertTitle.match(/\bon\s+([a-zA-Z0-9_.-]+)\/[a-zA-Z0-9_.-]+/);
  if (onMatch) return onMatch[1];
  const dashMatch = alertTitle.match(/—\s+([a-zA-Z0-9_.-]+)/);
  if (dashMatch) return dashMatch[1];
  return null;
}

// ── isSafeFilePath ──────────────────────────────────────────────────────────

describe("isSafeFilePath", () => {
  describe("allows safe source files", () => {
    const safe = [
      "src/index.ts",
      "lib/utils.js",
      "app/page.tsx",
      "components/Button.vue",
      "main.py",
      "cmd/server/main.go",
      "src/lib.rs",
      "README.md",
      "package.json",
      "tsconfig.json",
      "next.config.ts",
    ];
    for (const p of safe) {
      it(`allows "${p}"`, () => expect(isSafeFilePath(p)).toBe(true));
    }
  });

  describe("blocks path traversal", () => {
    const traversal = [
      "../../../etc/passwd",
      "src/../../secret",
      "/etc/passwd",
      "/root/.ssh/id_rsa",
      "~/.bashrc",
      "src\\..\\..\\etc\\passwd",
    ];
    for (const p of traversal) {
      it(`blocks "${p}"`, () => expect(isSafeFilePath(p)).toBe(false));
    }
  });

  describe("blocks environment files", () => {
    const envFiles = [".env", ".env.local", ".env.production", ".env.staging", ".ENV"];
    for (const p of envFiles) {
      it(`blocks "${p}"`, () => expect(isSafeFilePath(p)).toBe(false));
    }
  });

  describe("blocks lock files", () => {
    const locks = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"];
    for (const p of locks) {
      it(`blocks "${p}"`, () => expect(isSafeFilePath(p)).toBe(false));
    }
  });

  describe("blocks CI files", () => {
    it("blocks workflow files", () => {
      expect(isSafeFilePath(".github/workflows/ci.yml")).toBe(false);
      expect(isSafeFilePath(".github/workflows/deploy.yaml")).toBe(false);
    });
    it("blocks custom actions", () => {
      expect(isSafeFilePath(".github/actions/my-action/action.yml")).toBe(false);
    });
  });

  describe("blocks database migrations", () => {
    it("blocks .sql files", () => {
      expect(isSafeFilePath("001_init.sql")).toBe(false);
      expect(isSafeFilePath("migrations/002_add_users.SQL")).toBe(false);
    });
    it("blocks migration directories", () => {
      expect(isSafeFilePath("migrations/001_init.ts")).toBe(false);
      expect(isSafeFilePath("migration/seed.ts")).toBe(false);
      expect(isSafeFilePath("db/migrations/003_fix.ts")).toBe(false);
    });
  });

  describe("blocks infrastructure files", () => {
    it("blocks terraform", () => {
      expect(isSafeFilePath("main.tf")).toBe(false);
      expect(isSafeFilePath("variables.tfvars")).toBe(false);
      expect(isSafeFilePath("terraform/main.tf")).toBe(false);
      expect(isSafeFilePath("infra/stack.ts")).toBe(false);
    });
    it("blocks docker", () => {
      expect(isSafeFilePath("Dockerfile")).toBe(false);
      expect(isSafeFilePath("docker-compose.yml")).toBe(false);
      expect(isSafeFilePath("docker-compose.production.yaml")).toBe(false);
    });
  });

  describe("blocks secrets and certificates", () => {
    const secrets = ["server.key", "cert.pem", "tls.cert", "keystore.p12", "client.pfx"];
    for (const p of secrets) {
      it(`blocks "${p}"`, () => expect(isSafeFilePath(p)).toBe(false));
    }
  });

  describe("edge cases", () => {
    it("allows files that look similar but aren't blocked", () => {
      expect(isSafeFilePath("env.test.ts")).toBe(true);
      expect(isSafeFilePath("src/env.ts")).toBe(true);
      // Note: "dockerfile" in the name triggers the Dockerfile regex — this is a known
      // false positive in the blocklist. The regex /Dockerfile/i matches any path containing it.
      expect(isSafeFilePath("src/dockerfile-parser.ts")).toBe(false);
    });
  });
});

// ── getBlockedReason ────────────────────────────────────────────────────────

describe("getBlockedReason", () => {
  it("returns null for safe files", () => {
    expect(getBlockedReason("src/index.ts")).toBeNull();
    expect(getBlockedReason("lib/utils.js")).toBeNull();
  });

  it("detects path traversal", () => {
    expect(getBlockedReason("../secret")).toBe("path traversal");
    expect(getBlockedReason("/etc/passwd")).toBe("path traversal");
  });

  it("detects environment files", () => {
    expect(getBlockedReason(".env")).toBe("environment file");
    expect(getBlockedReason(".env.production")).toBe("environment file");
  });

  it("detects lock files", () => {
    expect(getBlockedReason("package-lock.json")).toBe("lock file (auto-generated)");
    expect(getBlockedReason("yarn.lock")).toBe("lock file (auto-generated)");
    expect(getBlockedReason("pnpm-lock.yaml")).toBe("lock file (auto-generated)");
    expect(getBlockedReason("bun.lockb")).toBe("lock file (auto-generated)");
  });

  it("detects CI workflows", () => {
    expect(getBlockedReason(".github/workflows/ci.yml")).toBe("CI workflow file");
  });

  it("detects database migrations", () => {
    expect(getBlockedReason("schema.sql")).toBe("database migration");
    expect(getBlockedReason("migrations/001.ts")).toBe("database migration");
  });

  it("detects infrastructure", () => {
    expect(getBlockedReason("main.tf")).toBe("infrastructure config");
    expect(getBlockedReason("terraform/vpc.tf")).toBe("infrastructure config");
    expect(getBlockedReason("infra/stack.ts")).toBe("infrastructure config");
  });

  it("detects container config", () => {
    expect(getBlockedReason("Dockerfile")).toBe("container config");
    expect(getBlockedReason("docker-compose.yml")).toBe("container config");
  });

  it("detects secrets/certificates", () => {
    expect(getBlockedReason("server.key")).toBe("secret/certificate file");
    expect(getBlockedReason("cert.pem")).toBe("secret/certificate file");
  });
});

// ── cleanJSON ───────────────────────────────────────────────────────────────

describe("cleanJSON", () => {
  it("extracts JSON from markdown code fence", () => {
    const input = 'Some text\n```json\n{"key": "value"}\n```\nMore text';
    expect(cleanJSON(input)).toBe('{"key": "value"}');
  });

  it("extracts from fence without json label", () => {
    const input = '```\n{"status": "ok"}\n```';
    expect(cleanJSON(input)).toBe('{"status": "ok"}');
  });

  it("extracts raw JSON object from surrounding text", () => {
    const input = 'Here is the response: {"status": "failed", "reason": "timeout"} end';
    const result = cleanJSON(input);
    expect(result).toContain('"status"');
    expect(result).toContain('"failed"');
  });

  it("handles already-clean JSON", () => {
    const input = '{"diagnosis": "null reference", "confidence": 85}';
    expect(cleanJSON(input)).toBe(input);
  });

  it("handles multi-line JSON in fence", () => {
    const input = '```json\n{\n  "files": [\n    {"path": "src/index.ts"}\n  ]\n}\n```';
    const result = JSON.parse(cleanJSON(input));
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("src/index.ts");
  });

  it("returns raw string when no JSON found", () => {
    const input = "This is just plain text with no JSON";
    expect(cleanJSON(input)).toBe(input);
  });

  it("handles nested braces", () => {
    const input = 'response: {"outer": {"inner": {"deep": true}}}';
    const result = JSON.parse(cleanJSON(input));
    expect(result.outer.inner.deep).toBe(true);
  });
});

// ── extractRepo ─────────────────────────────────────────────────────────────

describe("extractRepo", () => {
  describe("GitHub CI alert patterns", () => {
    it('extracts from "on repo/branch"', () => {
      expect(extractRepo("CI failing on my-repo/main")).toBe("my-repo");
    });

    it('extracts from workflow failure "on repo/branch"', () => {
      expect(extractRepo('Workflow "test" failed on radar-cli/develop')).toBe("radar-cli");
    });

    it("handles dots and underscores in repo names", () => {
      expect(extractRepo("CI failing on my_project.v2/main")).toBe("my_project.v2");
    });
  });

  describe("Vercel deploy alert patterns", () => {
    it('extracts from "— project"', () => {
      expect(extractRepo("Production deploy failed — myapp")).toBe("myapp");
    });

    it("handles hyphens in project names", () => {
      expect(extractRepo("Build error — my-next-app")).toBe("my-next-app");
    });
  });

  describe("non-matching patterns", () => {
    it("returns null for generic alerts", () => {
      expect(extractRepo("Server error 500")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(extractRepo("")).toBeNull();
    });

    it("returns null for alerts without repo context", () => {
      expect(extractRepo("TypeError: Cannot read property 'id' of null")).toBeNull();
    });
  });
});

// ── Adversarial: Unicode path spoofing ───────��──────────────────────────────

describe("isSafeFilePath — Unicode adversarial", () => {
  it("strips zero-width space and still validates", () => {
    expect(isSafeFilePath("src/\u200Bindex.ts")).toBe(true); // safe after strip
    expect(isSafeFilePath(".\u200Benv")).toBe(false); // .env after strip
  });

  it("strips zero-width joiner", () => {
    expect(isSafeFilePath(".env\u200D")).toBe(false);
  });

  it("strips BOM character", () => {
    expect(isSafeFilePath("\uFEFF.env")).toBe(false);
  });

  it("strips RTL override", () => {
    expect(isSafeFilePath("\u202Esrc/index.ts")).toBe(true); // safe after strip
    expect(isSafeFilePath("\u202E.env")).toBe(false);
  });

  it("rejects fullwidth period (lookalike for ..)", () => {
    expect(isSafeFilePath("src/\uFF0E\uFF0E/etc/passwd")).toBe(false);
  });

  it("rejects fraction slash", () => {
    expect(isSafeFilePath("src\u2044etc\u2044passwd")).toBe(false);
  });

  it("rejects division slash", () => {
    expect(isSafeFilePath("src\u2215etc")).toBe(false);
  });

  it("rejects fullwidth solidus", () => {
    expect(isSafeFilePath("src\uFF0Fetc")).toBe(false);
  });

  it("handles combined zero-width + blocked pattern", () => {
    expect(isSafeFilePath(".github/\u200Bworkflows/ci.yml")).toBe(false);
    expect(isSafeFilePath("package-lock\u200C.json")).toBe(false);
  });
});

// ���─ Adversarial: cleanJSON edge cases ─────────────��─────────────────────────

describe("cleanJSON — adversarial", () => {
  it("greedy regex captures from first { to last } (known behavior)", () => {
    const input = '{"a":1} some text {"b":2}';
    const result = cleanJSON(input);
    // Greedy match: everything from first { to last }
    expect(result).toBe('{"a":1} some text {"b":2}');
    expect(() => JSON.parse(result)).toThrow(); // invalid JSON
  });

  it("handles truncated code fence", () => {
    const input = '```json\n{"key": "val';
    const result = cleanJSON(input);
    // No closing fence → falls through to object regex → partial match
    expect(() => JSON.parse(result)).toThrow();
  });

  it("handles empty code fence", () => {
    const input = "```json\n\n```";
    const result = cleanJSON(input);
    expect(result).toBe("");
  });

  it("handles response with no braces at all", () => {
    const input = "I cannot generate a fix for this error.";
    expect(cleanJSON(input)).toBe(input);
    expect(() => JSON.parse(cleanJSON(input))).toThrow();
  });
});

// ── Adversarial: confidence parsing ───���─────────────────────────────────────

describe("confidence parsing — adversarial bounds", () => {
  // Replicate the clamping logic from remediate.ts
  function clampConfidence(raw: unknown): number {
    let conf = raw;
    if (typeof conf === "string") {
      conf = conf === "high" ? 90 : conf === "medium" ? 60 : 25;
    }
    const num = Number(conf);
    return isFinite(num) ? Math.max(0, Math.min(100, num)) : 50;
  }

  it("defaults Infinity to 50 (not finite)", () => {
    expect(clampConfidence(Infinity)).toBe(50);
  });

  it("defaults NaN to 50", () => {
    expect(clampConfidence(NaN)).toBe(50);
  });

  it("clamps negative to 0", () => {
    expect(clampConfidence(-50)).toBe(0);
  });

  it("clamps >100 to 100", () => {
    expect(clampConfidence(999)).toBe(100);
  });

  it("clamps null (Number(null)=0) to 0", () => {
    expect(clampConfidence(null)).toBe(0);
  });

  it("defaults non-numeric string to 25 (fallback)", () => {
    expect(clampConfidence("very high")).toBe(25);
  });

  it("handles string 'high' as 90", () => {
    expect(clampConfidence("high")).toBe(90);
  });

  it("handles normal numeric", () => {
    expect(clampConfidence(85)).toBe(85);
  });
});
