/**
 * Compliance scan — GDPR / SOC2 / PCI DSS static checks for a fix diff.
 *
 * Mirrors the shape of security-scan.ts — regex-based per-line matcher
 * that runs in-memory on Vercel serverless, no external API. Unlike
 * security-scan it does NOT run ESLint (the rules are regulatory, not
 * lint-level) and does NOT invoke AI (v1 — AI review could be added
 * later as aiComplianceReview).
 *
 * Used by VAR Gate 15 Compliance: fix fails the gate when a HIGH-severity
 * violation is introduced by the remediation. MEDIUM/LOW findings are
 * surfaced to the reviewer but do not fail the gate — they require
 * context (e.g., email column could be encrypted at the app layer).
 *
 * Rules are clustered by regulation:
 *   - GDPR  — PII in logs, unencrypted personal data columns, cookies
 *             without consent, PII in URLs, third-party PII transfer
 *   - SOC2  — auth disabled, TLS verification off, rate limit bypass,
 *             hardcoded admin checks, CSP weakening
 *   - PCI   — card data in logs, plaintext PAN, CVV storage, deprecated
 *             crypto, payment endpoint over HTTP
 */

// ── Types ────────────────────────────────────────────────────────────────

export type ComplianceCategory = "GDPR" | "SOC2" | "PCI";

export type ComplianceFinding = {
  file: string;
  line: number;
  category: ComplianceCategory;
  severity: "HIGH" | "MEDIUM" | "LOW";
  rule: string;
  message: string;
  snippet: string;
};

export type ComplianceScanResult = {
  /** True when zero HIGH-severity findings. Medium/low never fail the gate. */
  passed: boolean;
  findings: ComplianceFinding[];
  totalViolations: number;
  gdprCount: number;
  soc2Count: number;
  pciCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
};

// ── Rule catalog ─────────────────────────────────────────────────────────

interface ComplianceRule {
  pattern: RegExp;
  category: ComplianceCategory;
  severity: "HIGH" | "MEDIUM" | "LOW";
  rule: string;
  message: string;
}

export const COMPLIANCE_RULES: ComplianceRule[] = [
  // ── GDPR ──────────────────────────────────────────────────────────────
  {
    // Plain PII (email, SSN, DOB, phone, address tokens) dereferenced inside
    // a console.* call. Excludes logger wrappers that redact by convention.
    pattern: /console\.(?:log|info|warn|error|debug)\s*\([^)]*\b(?:user\.email|user_email|email_address|\.ssn\b|social_security|date_of_birth|phone_number|home_address|full_name)\b/i,
    category: "GDPR",
    severity: "HIGH",
    rule: "gdpr/pii-in-logs",
    message: "Logging PII without redaction — violates GDPR Article 5(1)(c) data minimization.",
  },
  {
    // SSN-like columns in plaintext are always a violation regardless of
    // context. Email/phone are MEDIUM (see next rule) because they may be
    // encrypted at the app layer.
    pattern: /\b(?:ssn|social_security_number|passport_number|national_id)\s*:\s*(?:text|varchar|char)\s*\(/i,
    category: "GDPR",
    severity: "HIGH",
    rule: "gdpr/sensitive-pii-plaintext-column",
    message: "High-sensitivity PII stored in plaintext column — GDPR Article 32 requires appropriate encryption.",
  },
  {
    pattern: /\b(?:email|phone_number|date_of_birth|home_address)\s*:\s*(?:text|varchar|char)\s*\(/i,
    category: "GDPR",
    severity: "MEDIUM",
    rule: "gdpr/pii-plaintext-column",
    message: "PII column without explicit encryption — verify field-level encryption is applied.",
  },
  {
    pattern: /document\.cookie\s*=/,
    category: "GDPR",
    severity: "MEDIUM",
    rule: "gdpr/cookie-set-review-consent",
    message: "Setting document.cookie directly — verify ePrivacy consent has been collected first.",
  },
  {
    // Interpolated PII in a URL (GET param). Leaks to server access logs
    // and analytics even if HTTPS is used.
    pattern: /[?&](?:email|phone|ssn|name|dob)=\$\{[^}]+\}/i,
    category: "GDPR",
    severity: "HIGH",
    rule: "gdpr/pii-in-url-query",
    message: "PII in URL query string — leaks to logs/referrers/analytics, violates data minimization.",
  },
  {
    // Logging full request.body is frequently where accidental PII leaks
    // originate. Flag as MEDIUM so the reviewer confirms redaction.
    pattern: /console\.(?:log|info|warn|error|debug)\s*\([^)]*\b(?:req|request|ctx)\.body\b[^)]*\)/,
    category: "GDPR",
    severity: "MEDIUM",
    rule: "gdpr/raw-request-body-log",
    message: "Logging raw request body — ensure PII is stripped before emitting.",
  },

  // ── SOC2 ──────────────────────────────────────────────────────────────
  {
    pattern: /\b(?:auth|requireAuth|authenticate|authentication|skipAuth)\s*:\s*(?:false|true\s*\/\/.*skip)/i,
    category: "SOC2",
    severity: "HIGH",
    rule: "soc2/auth-disabled",
    message: "Authentication disabled in config — violates SOC2 CC6.1 (logical access controls).",
  },
  {
    pattern: /\brejectUnauthorized\s*:\s*false\b/,
    category: "SOC2",
    severity: "HIGH",
    rule: "soc2/tls-verification-disabled",
    message: "TLS certificate verification disabled — MITM exposure violates SOC2 CC6.7 (transmission integrity).",
  },
  {
    pattern: /\bsecure\s*:\s*false\b|\bhttpOnly\s*:\s*false\b/,
    category: "SOC2",
    severity: "MEDIUM",
    rule: "soc2/insecure-cookie-flags",
    message: "Session cookie with secure=false or httpOnly=false — weakens session protection.",
  },
  {
    pattern: /\b(?:skipRateLimit|bypassRateLimit|rateLimit\s*:\s*false|rateLimiting\s*:\s*false)\b/,
    category: "SOC2",
    severity: "MEDIUM",
    rule: "soc2/rate-limit-disabled",
    message: "Rate limiting disabled — DoS/brute-force exposure, violates SOC2 availability principle.",
  },
  {
    // Hardcoded admin check by string literal — should be role/permission
    // based. Common pattern that bypasses RBAC.
    pattern: /if\s*\(\s*(?:user|req\.user|ctx\.user)\.(?:id|email|role|name|username)\s*===?\s*["'](?:admin|root|superuser|god)["']/i,
    category: "SOC2",
    severity: "MEDIUM",
    rule: "soc2/hardcoded-admin-check",
    message: "Hardcoded admin identifier check — violates SOC2 CC6.3 (role-based authorization).",
  },
  {
    pattern: /Content-Security-Policy.*?unsafe-eval/i,
    category: "SOC2",
    severity: "MEDIUM",
    rule: "soc2/csp-unsafe-eval",
    message: "CSP allows unsafe-eval — weakens XSS defense-in-depth.",
  },

  // ── PCI DSS ───────────────────────────────────────────────────────────
  {
    pattern: /console\.(?:log|info|warn|error|debug)\s*\([^)]*\b(?:cvv|cvc|card_?verification|card_?number|cardNumber|card_?pan|pan_?data)\b/i,
    category: "PCI",
    severity: "HIGH",
    rule: "pci/card-data-in-logs",
    message: "Logging card data — violates PCI DSS 3.4 (never log full PAN/CVV in any form).",
  },
  {
    pattern: /\b(?:card_?number|card_?pan|primary_account_number|\bpan)\s*:\s*(?:text|varchar|char|string)\s*\(/i,
    category: "PCI",
    severity: "HIGH",
    rule: "pci/pan-plaintext-column",
    message: "Card PAN in plaintext column — PCI DSS 3.4 requires strong cryptographic protection at rest.",
  },
  {
    pattern: /\b(?:cvv|cvc|cvv2|cvc2|card_?verification)\s*:\s*(?:text|varchar|integer|string|number|char)\s*\(/i,
    category: "PCI",
    severity: "HIGH",
    rule: "pci/cvv-storage-forbidden",
    message: "Storing CVV/CVC — PCI DSS 3.2 strictly prohibits post-authorization storage.",
  },
  {
    pattern: /\bcrypto\.createCipher\s*\(|\brequire\(['"]crypto['"]\)\.createCipher\s*\(/,
    category: "PCI",
    severity: "HIGH",
    rule: "pci/deprecated-cipher",
    message: "crypto.createCipher is deprecated and reuses a predictable IV — use createCipheriv with random IV.",
  },
  {
    // Any payment-ish endpoint reached over plain HTTP. Excludes localhost
    // so dev-mode doesn't false-positive.
    pattern: /fetch\s*\(\s*["']http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^"']*\/(?:charge|payment|pay|checkout|stripe|card)/i,
    category: "PCI",
    severity: "HIGH",
    rule: "pci/payment-over-http",
    message: "Payment-related endpoint reached over unencrypted HTTP — PCI DSS 4.1 requires TLS in transit.",
  },
];

// ── Scanner ──────────────────────────────────────────────────────────────

/**
 * Scan a batch of files for compliance violations. Skips non-code files
 * (images, binaries). De-duplicates findings on the same (file, line,
 * rule) tuple so a single violating line doesn't count twice when two
 * regex patterns both match.
 */
export function scanCompliance(
  files: { path: string; content: string }[],
): ComplianceScanResult {
  const findings: ComplianceFinding[] = [];
  const CODE_FILE = /\.(?:js|jsx|ts|tsx|mjs|cjs|py|rb|go|java|cs|php|sql)$/;

  for (const file of files) {
    if (!CODE_FILE.test(file.path)) continue;
    const lines = file.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comment-only lines — regulatory rules typically don't apply
      // to human-readable documentation / headers.
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;

      for (const rule of COMPLIANCE_RULES) {
        if (rule.pattern.test(line)) {
          const exists = findings.some(
            (f) => f.file === file.path && f.line === i + 1 && f.rule === rule.rule,
          );
          if (!exists) {
            findings.push({
              file: file.path,
              line: i + 1,
              category: rule.category,
              severity: rule.severity,
              rule: rule.rule,
              message: rule.message,
              snippet: line.trim().slice(0, 200),
            });
          }
        }
      }
    }
  }

  const highCount = findings.filter((f) => f.severity === "HIGH").length;
  const mediumCount = findings.filter((f) => f.severity === "MEDIUM").length;
  const lowCount = findings.filter((f) => f.severity === "LOW").length;

  const gdprCount = findings.filter((f) => f.category === "GDPR").length;
  const soc2Count = findings.filter((f) => f.category === "SOC2").length;
  const pciCount = findings.filter((f) => f.category === "PCI").length;

  return {
    passed: highCount === 0,
    findings,
    totalViolations: findings.length,
    gdprCount,
    soc2Count,
    pciCount,
    highCount,
    mediumCount,
    lowCount,
  };
}
