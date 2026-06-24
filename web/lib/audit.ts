import { db, auditLogs } from "@/lib/db";

/**
 * Log an audit event. Non-blocking — caller should not await in hot paths.
 */
export async function logAudit(opts: {
  userId: string;
  action: string;
  resource: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}) {
  try {
    await db.insert(auditLogs).values({
      userId: opts.userId,
      action: opts.action,
      resource: opts.resource,
      resourceId: opts.resourceId,
      metadata: opts.metadata,
      ipAddress: opts.ipAddress,
    });
  } catch {
    // Audit logging should never break the calling operation
  }
}
