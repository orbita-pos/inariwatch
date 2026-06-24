/**
 * Pure (no DB / no R2) part of the retention logic, isolated so unit
 * tests can import it without spinning up Neon at module-load.
 */

import { DEFAULT_REPLAY_SETTINGS } from "@/lib/db/schema";

/** Hard floor — anything older than 366 days gets deleted regardless of
 *  the project's `retentionDays` setting (defends against settings being
 *  set to "forever" by mistake). */
export const ABSOLUTE_MAX_RETENTION_DAYS = 366;

/**
 * Pure decision: should a session created at `createdAt` be deleted now?
 * - `null/undefined` → falls back to default (7).
 * - clamped to [1, ABSOLUTE_MAX_RETENTION_DAYS] so a tampered jsonb can't
 *   give a row infinite retention.
 */
export function isExpired(
  createdAt: Date,
  retentionDays: number | null | undefined,
  now: Date,
): boolean {
  const days = Math.min(
    ABSOLUTE_MAX_RETENTION_DAYS,
    Math.max(1, retentionDays ?? DEFAULT_REPLAY_SETTINGS.retentionDays),
  );
  const ageMs = now.getTime() - createdAt.getTime();
  return ageMs >= days * 24 * 60 * 60 * 1000;
}
