/**
 * Alert triage classifier — routes alerts to the cheapest effective path.
 *
 * Three classes:
 *   - auto_fix:          Known pattern with deterministic fix (skip AI entirely)
 *   - triage_only:       Needs analysis but NOT remediation (cheap model)
 *   - full_remediation:  Complex error that needs Sonnet-tier fix generation
 *
 * Two modes:
 *   1. Fine-tuned model (ALERT_CLASSIFIER_MODEL env var set) — ~85-90% accuracy
 *   2. Heuristic fallback — ~60% accuracy, zero cost
 *
 * Economics:
 *   Fine-tuned GPT-4o-mini: ~$0.0001/classification
 *   Without classifier:     ~$0.031/alert (Haiku analysis + Sonnet fix)
 *   With classifier:        ~$0.0077/alert (75% savings)
 */

export type TriageClass = "auto_fix" | "triage_only" | "full_remediation";

export interface ClassificationResult {
  triageClass: TriageClass;
  confidence: number;
  reason: string;
  method: "fine_tuned" | "heuristic";
}

const CLASSIFIER_MODEL = process.env.ALERT_CLASSIFIER_MODEL ?? "";

// ── Heuristic patterns (fallback when no fine-tuned model) ─────────────────

interface HeuristicRule {
  pattern: RegExp;
  triageClass: TriageClass;
  reason: string;
}

const HEURISTIC_RULES: HeuristicRule[] = [
  // auto_fix — well-known patterns with deterministic solutions
  { pattern: /Cannot read propert(y|ies) of (null|undefined)/i, triageClass: "auto_fix", reason: "null reference — add optional chaining or null check" },
  { pattern: /TypeError:.*is not a function/i, triageClass: "auto_fix", reason: "type error — wrong method call or missing import" },
  { pattern: /ReferenceError:.*is not defined/i, triageClass: "auto_fix", reason: "missing import or undeclared variable" },
  { pattern: /SyntaxError:/i, triageClass: "auto_fix", reason: "syntax error — parse failure" },
  { pattern: /Module not found.*Can't resolve/i, triageClass: "auto_fix", reason: "missing module — install or fix import path" },
  { pattern: /Cannot find module/i, triageClass: "auto_fix", reason: "missing module" },
  { pattern: /ENOENT.*no such file/i, triageClass: "auto_fix", reason: "missing file — fix path or create file" },
  { pattern: /off.by.one|off by one|fencepost/i, triageClass: "auto_fix", reason: "off-by-one error" },
  { pattern: /expected.*but (got|received)/i, triageClass: "auto_fix", reason: "type mismatch" },
  { pattern: /Property.*does not exist on type/i, triageClass: "auto_fix", reason: "TypeScript type error" },
  { pattern: /Argument of type.*is not assignable/i, triageClass: "auto_fix", reason: "TypeScript type mismatch" },
  { pattern: /type\s*error/i, triageClass: "auto_fix", reason: "type error — likely fixable with type annotation or cast" },
  { pattern: /deploy.*fail.*type|build.*fail.*type|preview.*fail.*type/i, triageClass: "auto_fix", reason: "deploy/build failed due to type error — deterministic fix" },
  { pattern: /build.*fail.*(?:import|module|resolve)/i, triageClass: "auto_fix", reason: "build failed due to import/module error" },

  // triage_only — informational, no code fix needed
  { pattern: /\bwarning\b.*deprecated/i, triageClass: "triage_only", reason: "deprecation warning — monitor, no immediate fix" },
  { pattern: /ExperimentalWarning/i, triageClass: "triage_only", reason: "experimental API warning" },
  { pattern: /\brate.limit/i, triageClass: "triage_only", reason: "rate limit hit — operational, not a code bug" },
  { pattern: /timeout.*exceeded|ETIMEDOUT|ECONNREFUSED/i, triageClass: "triage_only", reason: "network/infrastructure issue" },
  { pattern: /503 Service Unavailable|502 Bad Gateway/i, triageClass: "triage_only", reason: "upstream service down" },
  { pattern: /ENOMEM|out of memory|heap.*exceeded/i, triageClass: "triage_only", reason: "memory issue — needs infra scaling, not code fix" },
  { pattern: /disk.*full|ENOSPC/i, triageClass: "triage_only", reason: "disk space issue" },
  { pattern: /\bPR\b.*\b(?:unreviewed|stale|pending|abandoned|inactive)\b/i, triageClass: "triage_only", reason: "stale/unreviewed PR — notification only, no code fix" },
  { pattern: /\b(?:unreviewed|stale)\b.*\b(?:pull request|PR|merge request)\b/i, triageClass: "triage_only", reason: "stale/unreviewed PR — notification only, no code fix" },
  { pattern: /\bPR\b.*\b\d+\s*(?:hours?|days?|weeks?)\b/i, triageClass: "triage_only", reason: "PR age notification — no code fix needed" },
  { pattern: /\bcoverage\b.*(?:decreased|dropped|below)/i, triageClass: "triage_only", reason: "coverage drop — informational" },
  { pattern: /\bscheduled?\s*maintenance/i, triageClass: "triage_only", reason: "scheduled maintenance — informational" },

  // full_remediation — complex issues that need deep analysis
  { pattern: /race condition|deadlock/i, triageClass: "full_remediation", reason: "concurrency bug — needs careful analysis" },
  { pattern: /SQL injection|XSS|SSRF|CSRF/i, triageClass: "full_remediation", reason: "security vulnerability" },
  { pattern: /memory leak/i, triageClass: "full_remediation", reason: "memory leak — needs profiling context" },
  { pattern: /data.*corrupt|integrity.*violation/i, triageClass: "full_remediation", reason: "data integrity issue" },
];

function classifyByHeuristic(title: string, body: string): ClassificationResult {
  const text = `${title}\n${body}`;

  for (const rule of HEURISTIC_RULES) {
    if (rule.pattern.test(text)) {
      return {
        triageClass: rule.triageClass,
        confidence: 0.65,
        reason: rule.reason,
        method: "heuristic",
      };
    }
  }

  // Default: full remediation (safe fallback — never under-triage)
  return {
    triageClass: "full_remediation",
    confidence: 0.40,
    reason: "no heuristic match — defaulting to full analysis",
    method: "heuristic",
  };
}

// ── Fine-tuned model classification ────────────────────────────────────────

async function classifyByModel(
  apiKey: string,
  title: string,
  body: string,
  severity: string,
  source: string[],
): Promise<ClassificationResult> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLASSIFIER_MODEL,
      messages: [
        {
          role: "system",
          content: "Classify this alert into one of: auto_fix, triage_only, full_remediation. Respond with JSON: {\"class\":\"...\",\"confidence\":0.0-1.0,\"reason\":\"...\"}",
        },
        {
          role: "user",
          content: `severity: ${severity}\nsource: ${source.join(",")}\ntitle: ${title}\nbody: ${body.slice(0, 500)}`,
        },
      ],
      max_tokens: 80,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Classifier API error: ${response.status}`);
  }

  const data = await response.json() as {
    choices: { message: { content: string } }[];
  };

  const raw = data.choices[0]?.message?.content ?? "";
  const parsed = JSON.parse(raw) as {
    class: string;
    confidence: number;
    reason: string;
  };

  const validClasses: TriageClass[] = ["auto_fix", "triage_only", "full_remediation"];
  const triageClass = validClasses.includes(parsed.class as TriageClass)
    ? (parsed.class as TriageClass)
    : "full_remediation";

  return {
    triageClass,
    confidence: Math.min(Math.max(parsed.confidence ?? 0.5, 0), 1),
    reason: parsed.reason ?? "",
    method: "fine_tuned",
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Classify an alert to determine the cheapest effective triage path.
 *
 * Uses fine-tuned model if ALERT_CLASSIFIER_MODEL is set, falls back to
 * heuristics otherwise. Fine-tuned model costs ~$0.0001/call.
 */
export async function classifyAlert(
  title: string,
  body: string,
  severity: string,
  source: string[],
  platformKey?: string,
): Promise<ClassificationResult> {
  if (CLASSIFIER_MODEL && platformKey) {
    try {
      return await classifyByModel(platformKey, title, body, severity, source);
    } catch {
      // Fine-tuned model unavailable — fall back to heuristics
    }
  }

  return classifyByHeuristic(title, body);
}
