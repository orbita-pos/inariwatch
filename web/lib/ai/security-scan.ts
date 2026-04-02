/**
 * Security scan — ESLint-based static analysis + AI security review.
 * Runs in-memory on Vercel serverless. No CLI, no Docker, no external API.
 *
 * Used in the remediation pipeline before creating a PR.
 */

import { Linter } from "eslint";

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

// ── ESLint security rules ────────────────────────────────────────────────────

const SECURITY_RULES: Record<string, Linter.RuleEntry> = {
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
};

// Manual security patterns (supplement ESLint rules for common Node.js issues)
const DANGEROUS_PATTERNS: { pattern: RegExp; severity: SecurityFinding["severity"]; rule: string; message: string }[] = [
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
];

// ── Static scan (ESLint + pattern matching) ──────────────────────────────────

export function scanFiles(files: { path: string; content: string }[]): ScanResult {
  const findings: SecurityFinding[] = [];
  const linter = new Linter();

  for (const file of files) {
    // Skip non-JS/TS files
    if (!/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(file.path)) continue;

    // ESLint built-in rules
    try {
      const messages = linter.verify(file.content, {
        rules: SECURITY_RULES,
        parserOptions: { ecmaVersion: 2022, sourceType: "module" },
      }, { filename: file.path });

      for (const msg of messages) {
        if (msg.severity >= 2) {
          findings.push({
            file: file.path,
            line: msg.line,
            severity: "HIGH",
            rule: msg.ruleId ?? "unknown",
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
