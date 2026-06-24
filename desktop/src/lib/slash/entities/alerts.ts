/**
 * Inari Live Phase 5.2 — alert entity provider.
 *
 * Wraps `cloudGetAlerts(limit)` which fronts `/api/desktop/alerts`.
 * Collapses `CloudAlert` rows to the generic `AlertEntity` shape the
 * picker consumes. Carries `isResolved` so the picker can grey out
 * resolved rows (still visible — the user may want to silence a
 * resolved-but-recurring alert).
 */
import { cloudGetAlerts, type CloudAlert } from "../../cloud-ipc";

import type { AlertEntity } from "./types";

/** Exported for tests. */
export function toAlertEntity(a: CloudAlert): AlertEntity {
  return {
    id: a.id,
    hash: a.inariHash,
    title: a.title,
    severity: a.severity,
    projectName: a.projectName,
    createdAt: a.createdAt,
    isResolved: a.isResolved,
  };
}

export interface ListAlertsDeps {
  list?: (limit: number) => Promise<CloudAlert[]>;
}

/**
 * Return the most recent N alerts (default 20, capped to 100 by the
 * cloud route). Resolved alerts are included; the picker greys them
 * out but keeps them selectable so users can re-act on a flapping
 * incident.
 */
export async function listAlerts(
  limit = 20,
  deps: ListAlertsDeps = {},
): Promise<AlertEntity[]> {
  const list = deps.list ?? cloudGetAlerts;
  try {
    const alerts = await list(limit);
    return alerts.map(toAlertEntity);
  } catch {
    return [];
  }
}
