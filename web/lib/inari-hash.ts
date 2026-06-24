import { createHash } from "node:crypto";

export type InariHashType = "alert" | "rec" | "fix" | "receipt" | "conv";

/**
 * Content-addressed portable identifier for InariWatch objects.
 *
 * Format: inari:<type>:<16-hex>
 *
 * The payload must contain only stable, immutable fields — never mutable
 * state (isResolved, aiReasoning, etc.) so the hash stays valid forever.
 *
 * Keys are sorted before hashing so insertion order never affects the result.
 */
export function inariHash(
  type: InariHashType,
  payload: Record<string, string | null | undefined>
): string {
  const sorted = Object.keys(payload)
    .sort()
    .reduce<Record<string, string | null | undefined>>((acc, k) => {
      acc[k] = payload[k];
      return acc;
    }, {});
  const hex = createHash("sha256")
    .update(JSON.stringify(sorted), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `inari:${type}:${hex}`;
}

/**
 * Parse an inari hash string.
 * Accepts both full form (inari:alert:3fa85f64aabb1234)
 * and bare 16-hex (3fa85f64aabb1234) — bare form is type-ambiguous
 * and should only be used when the type is known from context.
 */
export function parseInariHash(
  raw: string
): { type: InariHashType; hex: string } | null {
  const full = raw.match(/^inari:([a-z]+):([0-9a-f]{16})$/);
  if (full) return { type: full[1] as InariHashType, hex: full[2] };
  const bare = raw.match(/^([0-9a-f]{16})$/);
  if (bare) return { type: "alert", hex: bare[1] }; // default to alert for bare form
  return null;
}

/** Truncated display form for UI (e.g., 3fa85f64) */
export function shortHash(hash: string): string {
  const parsed = parseInariHash(hash);
  return parsed ? parsed.hex.slice(0, 8) : hash.slice(0, 8);
}
