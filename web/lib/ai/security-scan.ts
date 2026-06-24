/**
 * Security scan — ESLint-based static analysis + AI security review.
 * Runs in-memory on Vercel serverless. No CLI, no Docker, no external API.
 *
 * Uses eslint-plugin-security (14 rules) + built-in ESLint rules (3) +
 * Semgrep-inspired regex patterns (19) + optional AI review.
 *
 * Used in the remediation pipeline before creating a PR.
 */

import { Linter } from "eslint";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const securityPlugin = require("eslint-plugin-security") as { rules?: Record<string, unknown> };

// ── Types ────────────────────────────────────────────────────────────────────

export type SecurityFinding = {
  file: string;
  line: number;
  severity: "HIGH" | "MEDIUM" | "LOW";
  rule: string;
  message: string;
};

export type ScanResult = {
  passed: boolean;
  findings: SecurityFinding[];
  highCount: number;
  mediumCount: number;
  lowCount: number;
};

// ── Rule severity mapping ───────────────────────────────────────────────────

/** Maps ESLint rule IDs to InariWatch severity. Rules not listed default to MEDIUM. */
const RULE_SEVERITY_MAP: Record<string, SecurityFinding["severity"]> = {
  // Built-in ESLint
  "no-eval": "HIGH",
  "no-implied-eval": "HIGH",
  "no-new-func": "HIGH",
  // eslint-plugin-security — HIGH
  "security/detect-unsafe-regex": "HIGH",
  "security/detect-eval-with-expression": "HIGH",
  "security/detect-child-process": "HIGH",
  "security/detect-no-csrf-before-method-override": "HIGH",
  "security/detect-disable-mustache-escape": "HIGH",
  "security/detect-bidi-characters": "HIGH",
  // eslint-plugin-security — MEDIUM
  "security/detect-non-literal-fs-filename": "MEDIUM",
  "security/detect-non-literal-regexp": "MEDIUM",
  "security/detect-non-literal-require": "MEDIUM",
  "security/detect-possible-timing-attacks": "MEDIUM",
  "security/detect-pseudoRandomBytes": "MEDIUM",
  "security/detect-buffer-noassert": "MEDIUM",
  "security/detect-object-injection": "MEDIUM",
  // eslint-plugin-security — LOW
  "security/detect-new-buffer": "LOW",
};

// ── ESLint security rules ────────────────────────────────────────────────────

const BUILTIN_RULES: Record<string, Linter.RuleEntry> = {
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
};

const PLUGIN_RULES: Record<string, Linter.RuleEntry> = {
  "security/detect-unsafe-regex": "warn",
  "security/detect-eval-with-expression": "warn",
  "security/detect-child-process": "warn",
  "security/detect-no-csrf-before-method-override": "warn",
  "security/detect-disable-mustache-escape": "warn",
  "security/detect-bidi-characters": "warn",
  "security/detect-non-literal-fs-filename": "warn",
  "security/detect-non-literal-regexp": "warn",
  "security/detect-non-literal-require": "warn",
  "security/detect-possible-timing-attacks": "warn",
  "security/detect-pseudoRandomBytes": "warn",
  "security/detect-buffer-noassert": "warn",
  "security/detect-object-injection": "warn",
  "security/detect-new-buffer": "warn",
};

// ── Dangerous patterns (regex-based, Semgrep-inspired) ─────────────────────

const DANGEROUS_PATTERNS: { pattern: RegExp; severity: SecurityFinding["severity"]; rule: string; message: string }[] = [
  // Original patterns
  { pattern: /eval\s*\(/, severity: "HIGH", rule: "security/no-eval", message: "Use of eval() — potential code injection" },
  { pattern: /child_process/, severity: "HIGH", rule: "security/detect-child-process", message: "Use of child_process — potential command injection" },
  { pattern: /\.exec\s*\(.*\$\{/, severity: "HIGH", rule: "security/detect-shell-injection", message: "Template literal in exec() — potential shell injection" },
  { pattern: /innerHTML\s*=/, severity: "HIGH", rule: "security/no-inner-html", message: "Direct innerHTML assignment — potential XSS" },
  { pattern: /dangerouslySetInnerHTML/, severity: "MEDIUM", rule: "security/react-dangerously-set", message: "dangerouslySetInnerHTML — verify input is sanitized" },
  { pattern: /new RegExp\s*\(.*\+/, severity: "MEDIUM", rule: "security/detect-non-literal-regexp", message: "Dynamic RegExp — potential ReDoS" },
  { pattern: /SELECT.*\+.*FROM|INSERT.*\+.*INTO|DELETE.*\+.*FROM/i, severity: "HIGH", rule: "security/detect-sql-injection", message: "String concatenation in SQL — potential SQL injection" },
  { pattern: /readFileSync\s*\(.*\+|readFile\s*\(.*\+/, severity: "MEDIUM", rule: "security/detect-path-traversal", message: "Dynamic file path — potential path traversal" },
  { pattern: /\.replace\s*\(\s*\/.*\/[^g]/, severity: "LOW", rule: "security/non-global-replace", message: "Non-global replace — may only replace first occurrence" },
  { pattern: /process\.env\.\w+.*password|process\.env\.\w+.*secret/i, severity: "MEDIUM", rule: "security/env-secret-usage", message: "Environment variable with sensitive name — ensure not logged" },
  { pattern: /Buffer\.from\s*\([^,]+\)\s*\.toString\s*\(\s*\)/, severity: "LOW", rule: "security/buffer-encoding", message: "Buffer.from without encoding — defaults to utf8" },

  // Semgrep-inspired patterns
  { pattern: /fetch\s*\(\s*[^"'`\s]/, severity: "HIGH", rule: "security/detect-ssrf", message: "Dynamic URL in fetch() — potential SSRF" },
  { pattern: /(password|secret|apikey|api_key|token)\s*[:=]\s*["'][^"']{8,}/i, severity: "HIGH", rule: "security/hardcoded-secret", message: "Hardcoded secret or credential — use environment variables" },
  { pattern: /__proto__/, severity: "HIGH", rule: "security/prototype-pollution", message: "__proto__ access — potential prototype pollution" },
  { pattern: /constructor\s*\[/, severity: "HIGH", rule: "security/prototype-pollution-constructor", message: "Dynamic constructor access — potential prototype pollution" },
  { pattern: /createHash\s*\(\s*['"](?:md5|sha1)['"]/, severity: "MEDIUM", rule: "security/insecure-hash", message: "Insecure hash algorithm (md5/sha1) — use sha256 or stronger" },
  { pattern: /res\.redirect\s*\(\s*req\.(query|params|body)/, severity: "HIGH", rule: "security/open-redirect", message: "Redirect using user input — potential open redirect" },
  { pattern: /Access-Control-Allow-Origin.*\*/, severity: "MEDIUM", rule: "security/cors-wildcard", message: "CORS wildcard origin — consider restricting to specific domains" },
  { pattern: /window\.location\s*=\s*[^"'`]/, severity: "MEDIUM", rule: "security/unvalidated-redirect", message: "Client-side redirect with dynamic value — validate URL first" },
];

// ── Static scan (ESLint + pattern matching) ──────────────────────────────────

export function scanFiles(files: { path: string; content: string }[]): ScanResult {
  const findings: SecurityFinding[] = [];
  const linter = new Linter();

  // Register eslint-plugin-security rules
  if (securityPlugin.rules) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    linter.defineRules(securityPlugin.rules as any);
  }

  const allRules = { ...BUILTIN_RULES, ...PLUGIN_RULES };

  for (const file of files) {
    // Skip non-JS/TS files
    if (!/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(file.path)) continue;

    // ESLint rules (built-in + eslint-plugin-security)
    try {
      const messages = linter.verify(file.content, {
        rules: allRules,
        parserOptions: { ecmaVersion: 2022, sourceType: "module" },
      }, { filename: file.path });

      for (const msg of messages) {
        if (msg.severity >= 1) {
          const ruleId = msg.ruleId ?? "unknown";
          findings.push({
            file: file.path,
            line: msg.line,
            severity: RULE_SEVERITY_MAP[ruleId] ?? "MEDIUM",
            rule: ruleId,
            message: msg.message,
          });
        }
      }
    } catch {
      // ESLint parse error — skip file
    }

    // Pattern-based detection
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const dp of DANGEROUS_PATTERNS) {
        if (dp.pattern.test(lines[i])) {
          // Don't duplicate findings on same line/rule
          const exists = findings.some(
            (f) => f.file === file.path && f.line === i + 1 && f.rule === dp.rule
          );
          if (!exists) {
            findings.push({
              file: file.path,
              line: i + 1,
              severity: dp.severity,
              rule: dp.rule,
              message: dp.message,
            });
          }
        }
      }
    }
  }

  const highCount = findings.filter((f) => f.severity === "HIGH").length;
  const mediumCount = findings.filter((f) => f.severity === "MEDIUM").length;
  const lowCount = findings.filter((f) => f.severity === "LOW").length;

  return {
    passed: highCount === 0,
    findings,
    highCount,
    mediumCount,
    lowCount,
  };
}

// ── AI security review ───────────────────────────────────────────────────────

const SECURITY_REVIEW_PROMPT = `You are a senior security engineer reviewing a code diff for vulnerabilities.

Check for:
1. SQL injection (string concatenation in queries)
2. XSS (unsanitized user input in HTML/DOM)
3. Command injection (user input in exec/spawn)
4. Path traversal (user input in file paths)
5. Authentication bypass (missing auth checks)
6. Data exposure (secrets, PII in logs or responses)
7. SSRF (user-controlled URLs in server-side fetch)
8. Prototype pollution
9. Insecure deserialization
10. Missing input validation

For each finding return EXACTLY this JSON format (array):
[{"severity":"HIGH","file":"path","line":42,"rule":"custom/description","message":"explanation"}]

If no vulnerabilities found, return: []
Return ONLY the JSON array, no other text.`;

export async function aiSecurityReview(
  files: { path: string; content: string }[],
  callAI: (key: string, system: string, messages: { role: "user"; content: string }[]) => Promise<string>,
  aiKey: string
): Promise<SecurityFinding[]> {
  const diff = files
    .map((f) => `=== ${f.path} ===\n${f.content.slice(0, 2000)}`)
    .join("\n\n")
    .slice(0, 6000);

  try {
    const result = await callAI(aiKey, SECURITY_REVIEW_PROMPT, [
      { role: "user", content: diff },
    ]);

    // Parse AI response
    const match = result.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]) as SecurityFinding[];
    return parsed.filter(
      (f) => f.severity && f.message && typeof f.line === "number"
    );
  } catch {
    return []; // AI review failure should not block the pipeline
  }
}
