/**
 * Confidence tiering (PR #7).
 *
 * Canonical three-tier representation of a remediation session's
 * confidence score, used across the dashboard, Slack, Telegram, and PR
 * comments. Instead of surfacing raw percentages everywhere (87%, 72%,
 * 41%), we also map into tri-color tiers that make the signal legible
 * at a glance.
 *
 * Thresholds from the GPT-5.4 roadmap + Devin 2.1 finding that
 * tri-color badges double merge rate in green vs yellow.
 */

export type ConfidenceTier = "green" | "yellow" | "red";

const GREEN_MIN = 80;
const YELLOW_MIN = 60;

/**
 * Map a 0-100 confidence score to a tri-color tier.
 *
 * - green:  >= 80  (high confidence — safe to auto-merge)
 * - yellow: 60-79  (moderate — human review recommended)
 * - red:    < 60   (low — escalate or drop)
 *
 * Null / undefined maps to red — we treat "no signal" as worst-case,
 * not as neutral.
 */
export function confidenceTier(score: number | null | undefined): ConfidenceTier {
  if (score == null || !Number.isFinite(score)) return "red";
  if (score >= GREEN_MIN) return "green";
  if (score >= YELLOW_MIN) return "yellow";
  return "red";
}

/**
 * Emoji for the tier — used in Slack / Telegram / PR comments where
 * a single glyph is enough.
 */
export function confidenceEmoji(tier: ConfidenceTier): string {
  switch (tier) {
    case "green": return "🟢";
    case "yellow": return "🟡";
    case "red": return "🔴";
  }
}

/**
 * Tailwind-classy color mapping — used by the dashboard badge.
 */
export function confidenceClasses(tier: ConfidenceTier): {
  text: string;
  bg: string;
  ring: string;
} {
  switch (tier) {
    case "green":
      return { text: "text-emerald-700 dark:text-emerald-300", bg: "bg-emerald-500/10", ring: "ring-emerald-500/30" };
    case "yellow":
      return { text: "text-amber-700 dark:text-amber-300", bg: "bg-amber-500/10", ring: "ring-amber-500/30" };
    case "red":
      return { text: "text-red-700 dark:text-red-300", bg: "bg-red-500/10", ring: "ring-red-500/30" };
  }
}

/**
 * One-liner for PR comments / Slack messages:
 *   "🟢 87% — safe to auto-merge"
 *   "🟡 72% — review recommended"
 *   "🔴 41% — escalated"
 */
export function confidenceLabel(score: number | null | undefined, gatesPassed?: number, gatesTotal?: number): string {
  const tier = confidenceTier(score);
  const emoji = confidenceEmoji(tier);
  const pct = score == null || !Number.isFinite(score) ? "—" : `${Math.round(score)}%`;

  const descriptor =
    tier === "green" ? "safe to auto-merge" :
    tier === "yellow" ? "review recommended" :
    "escalated";

  const gatesSuffix = gatesPassed != null && gatesTotal != null ? ` · ${gatesPassed}/${gatesTotal} gates` : "";
  return `${emoji} ${pct} — ${descriptor}${gatesSuffix}`;
}

/**
 * Short label for tight UIs (alert list, table rows):
 *   "🟢 87%"  /  "🟡 72%"  /  "🔴 41%"
 */
export function confidenceShortLabel(score: number | null | undefined): string {
  const tier = confidenceTier(score);
  const emoji = confidenceEmoji(tier);
  const pct = score == null || !Number.isFinite(score) ? "—" : `${Math.round(score)}%`;
  return `${emoji} ${pct}`;
}
