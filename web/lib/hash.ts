/**
 * Tiny hash utilities. Kept dependency-free + Node-stdlib-only so this can
 * be imported from server actions, Vercel edge runtime, and unit tests
 * without dragging in CryptoJS.
 */

import { createHash } from "node:crypto";

/**
 * Lowercase, trim, sha256 → 64-char hex. Used to fingerprint end-user
 * emails before storage so the dashboard's "hash mode" view can mask the
 * raw value without re-deriving anything per request.
 *
 * Returns null for non-string / empty input so callers can do
 * `email_hash = sha256Lower(email)` without a null-check ladder.
 */
export function sha256Lower(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
