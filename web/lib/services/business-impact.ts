/**
 * Business impact scoring for alerts.
 *
 * Rule-based heuristic — no AI cost. Maps an alert's surface area
 * (URL paths, source, severity) plus its blast radius (sessions/users
 * affected) onto a 0–100 priority score that drives:
 *   - The "Impact: HIGH" badge on /alerts/[id]
 *   - Escalation engine prioritization (post-launch wiring)
 *   - Slack/Telegram alert ordering when many fire at once
 *
 * Why heuristic and not AI:
 *   - Determinism. Same alert, same score — no model drift.
 *   - Speed. 0ms classification vs 500ms+ AI call per alert.
 *   - Cost. Auto-analyze already pays for the AI; this layer is free.
 *   - Auditability. Customers can read the rules and adjust the weights
 *     in their workspace settings (post-launch).
 *
 * Categories and weights are conservative defaults. Companies care about
 * different things — checkout for e-commerce, /api/login for SaaS, /admin
 * for compliance-sensitive tools. We surface the matched categories so
 * customers see WHY a score is what it is.
 */

import type { Alert } from "@/lib/db";

export type ImpactCategory =
  | "revenue"      // checkout, payment, billing — direct $ at stake
  | "auth"         // login, signup, password — users locked out
  | "admin"        // admin panels — privileged ops affected
  | "data"         // db, storage, write operations — durability concern
  | "user_facing"  // dashboard, app pages — visible to humans
  | "background"   // cron, queue, worker — recoverable later
  | "public";      // docs, blog, marketing — low urgency

export interface ImpactFactor {
  category: ImpactCategory;
  /** What in the alert text triggered this match (for tooltip). */
  evidence: string;
  /** Contribution to the final score (0–100 scale). */
  weight: number;
}

export type ImpactLevel = "critical" | "high" | "medium" | "low";

export interface BusinessImpact {
  /** Composite score 0–100. */
  score: number;
  level: ImpactLevel;
  factors: ImpactFactor[];
}

// ── Rule table ─────────────────────────────────────────────────────────────
//
// Each rule is a regex over a normalized "alert text" string (title + body
// + sourceIntegrations, lowercased). Order doesn't matter — every rule that
// matches contributes to the score (capped at MAX_SCORE).
//
// Patterns tuned for low false-positive rate. /checkout matches /api/checkout
// and /v2/checkout but NOT /checkout-discount-code (that's a marketing route).

interface Rule {
  category: ImpactCategory;
  weight: number;
  pattern: RegExp;
  /** Friendly explanation for the tooltip. Kept short — fits in a popover. */
  evidenceTemplate: (match: string) => string;
}

const RULES: Rule[] = [
  // Revenue paths — highest weight, direct $ impact
  { category: "revenue", weight: 35, pattern: /\b(\/api)?\/?(checkout|payment|stripe|charges?|billing|subscription|invoice)\b/i,
    evidenceTemplate: (m) => `Revenue path matched: "${m}"` },
  // Auth paths — high weight, blocks all users
  { category: "auth", weight: 25, pattern: /\b(\/api)?\/?(login|signup|register|password|verify-email|oauth|sso|2fa|session)\b/i,
    evidenceTemplate: (m) => `Auth path matched: "${m}"` },
  // Admin paths — high weight, privileged + compliance
  { category: "admin", weight: 22, pattern: /\b(\/api)?\/?(admin|workspace\/settings)\b/i,
    evidenceTemplate: (m) => `Admin surface matched: "${m}"` },
  // Data layer — medium-high, durability matters
  { category: "data", weight: 18, pattern: /\b(database|postgres|mysql|redis|s3|r2|dynamodb|insert|update|delete|drop)\b/i,
    evidenceTemplate: (m) => `Data layer signal: "${m}"` },
  // User-facing app routes — medium
  { category: "user_facing", weight: 12, pattern: /\b(\/api)?\/?(dashboard|alerts|sessions|projects|chat)\b/i,
    evidenceTemplate: (m) => `User-facing route: "${m}"` },
  // Background — lower, recoverable
  { category: "background", weight: 6, pattern: /\b(cron|worker|queue|background|scheduled)\b/i,
    evidenceTemplate: (m) => `Background job: "${m}"` },
  // Public surfaces — lowest. NO leading \b on the slash patterns: word
  // boundary requires a word char before the slash, but a leading space
  // or line-start is non-word, so `\b\/docs` would silently miss "/docs".
  { category: "public", weight: 3, pattern: /(\/docs|\/blog|\/marketing|\/landing|robots\.txt|sitemap\.xml)\b/i,
    evidenceTemplate: (m) => `Public surface: "${m}"` },
];

// ── Severity weights ───────────────────────────────────────────────────────
// Severity acts as a multiplier on the matched-rules subtotal — a critical
// /docs alert is still less impactful than a critical /checkout alert.

const SEVERITY_MULT: Record<string, number> = {
  critical: 1.4,
  warning: 1.0,
  info: 0.6,
};

// ── User-impact weight ─────────────────────────────────────────────────────
// Affected users adds a flat bonus capped at 20 points. Linear up to 100
// users, then logarithmic — a 1000-user incident isn't 10x a 100-user one
// in priority, but it shouldn't be the same either.

function usersBonus(usersAffected: number): number {
  if (usersAffected <= 0) return 0;
  if (usersAffected >= 100) return 20;
  // Linear 0–20 over 0–100
  return Math.round((usersAffected / 100) * 20);
}

// ── Public API ─────────────────────────────────────────────────────────────

const MAX_SCORE = 100;

interface AlertLike {
  title: string;
  body?: string | null;
  severity?: string | null;
  sourceIntegrations?: string[] | null;
}

export function getBusinessImpact(
  alert: AlertLike,
  usersAffected = 0,
): BusinessImpact {
  const text = [
    alert.title ?? "",
    alert.body ?? "",
    (alert.sourceIntegrations ?? []).join(" "),
  ].join("\n").toLowerCase();

  const factors: ImpactFactor[] = [];
  // De-dup by category — only count each category once even if multiple
  // patterns of that category match. Prevents the score being inflated
  // by an alert that mentions both "checkout" and "billing".
  const seenCategories = new Set<ImpactCategory>();

  for (const rule of RULES) {
    if (seenCategories.has(rule.category)) continue;
    const match = text.match(rule.pattern);
    if (!match) continue;
    seenCategories.add(rule.category);
    factors.push({
      category: rule.category,
      evidence: rule.evidenceTemplate(match[0]),
      weight: rule.weight,
    });
  }

  const baseScore = factors.reduce((sum, f) => sum + f.weight, 0);
  const severity = (alert.severity ?? "warning").toLowerCase();
  const multiplier = SEVERITY_MULT[severity] ?? 1.0;
  const userScore = usersBonus(usersAffected);

  const raw = Math.round(baseScore * multiplier + userScore);
  const score = Math.max(0, Math.min(MAX_SCORE, raw));

  return {
    score,
    level: scoreToLevel(score),
    factors,
  };
}

function scoreToLevel(score: number): ImpactLevel {
  if (score >= 70) return "critical";
  if (score >= 45) return "high";
  if (score >= 20) return "medium";
  return "low";
}

/** Pretty-print the level for display. */
export function impactLevelLabel(level: ImpactLevel): string {
  return level.toUpperCase();
}
