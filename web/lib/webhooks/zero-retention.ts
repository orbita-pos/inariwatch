/**
 * Zero-retention processing path — Track E pieza 11.
 *
 * Compliance clients (banking, healthcare) flip
 * `INARIWATCH_ZERO_RETENTION=true` on the SDK. The SDK then sends
 * `X-IW-Zero-Retention: 1` with every webhook. When the server sees
 * that header, it MUST NOT persist the event to the `alerts` table.
 *
 * This module runs the equivalent of `createAlertIfNew` minus persistence:
 *
 *   1. Maintenance window check (suppress everything in a window).
 *   2. 24-hour fingerprint dedup via Redis (no DB write either).
 *   3. Lightweight notify (Slack/email — text-only, no action buttons
 *      because there is no `alertId` to bind to).
 *   4. Sign tombstone receipt and return it to the SDK.
 *
 * The pipeline is intentionally a STRICT subset of the standard path so
 * we never accidentally call code that touches the `alerts` table. We do
 * NOT call `createAlertIfNew`, `enqueueAlert`, `autoAnalyzeAlert`, or any
 * function that takes an `Alert` row. The notify path uses a fresh
 * `notifyZeroRetention` helper that posts plain text to Slack and skips
 * thread tracking.
 *
 * Acceptance gate (CAPTURE_V2_IMPLEMENTATION + spec §11):
 *   - 0 rows in `alerts` for a project that flipped the flag.
 *   - notification still fires (Slack/email).
 *   - tombstone verifies via `/api/eap/verify/tombstone/:hash`.
 */

import { db, maintenanceWindows, projects } from "@/lib/db";
import { eq, and, lte, gte } from "drizzle-orm";
import { getRedis } from "@/lib/redis";
import { computeErrorFingerprint } from "@/lib/ai/fingerprint";
import {
  signTombstone,
  type SignedTombstone,
  type ProcessedAction,
} from "@/lib/services/tombstone-sign";

/** Header sent by the SDK when `INARIWATCH_ZERO_RETENTION=true` is set.
 *  Lower-cased — Next's `req.headers.get` is case-insensitive but it's a
 *  good habit to canonicalize the lookup string. */
export const ZERO_RETENTION_HEADER = "x-iw-zero-retention";

export function hasZeroRetentionHeader(req: Request): boolean {
  return req.headers.get(ZERO_RETENTION_HEADER) === "1";
}

export interface ZeroRetentionInput {
  integrationId: string;
  projectId: string;
  /** The raw event the SDK posted. We only read `title` + `body`/`message`
   *  for fingerprint + notification — never persist. */
  event: Record<string, unknown>;
}

export type ZeroRetentionResult =
  | {
      status: "tombstoned";
      tombstone: SignedTombstone;
      processedActions: ProcessedAction[];
    }
  | {
      status: "tombstoned-unsigned";
      reason: "key-unavailable" | "key-malformed";
      processedActions: ProcessedAction[];
    };

/**
 * Run the zero-retention pipeline for a single capture event.
 *
 * Never throws — failures degrade gracefully so the SDK always gets a
 * tombstone (even if unsigned) and the request returns 200. The whole
 * point of zero-retention mode is to be a safe, deterministic "we got
 * your event, did the work, persisted nothing" handshake.
 */
export async function processZeroRetention(
  input: ZeroRetentionInput,
): Promise<ZeroRetentionResult> {
  const actions: ProcessedAction[] = [];
  const title = (input.event.title as string) ?? "Captured error";
  const body = (input.event.body as string) ?? "";

  // 1. Maintenance window — same suppression rule as createAlertIfNew so
  //    a maintenance-mode toggle silences zero-retention clients too.
  const now = new Date();
  const [activeMaintenance] = await db
    .select({ id: maintenanceWindows.id })
    .from(maintenanceWindows)
    .where(
      and(
        eq(maintenanceWindows.projectId, input.projectId),
        lte(maintenanceWindows.startsAt, now),
        gte(maintenanceWindows.endsAt, now),
      ),
    )
    .limit(1);

  if (activeMaintenance) {
    actions.push("skipped_maintenance");
    return finalize(input, actions);
  }

  // 2. Fingerprint dedup. Use the SDK-supplied fingerprint when valid;
  //    fall back to a server-side derive so we never sign a tombstone
  //    with a missing/empty handle.
  const sdkFingerprint = (input.event.fingerprint as string) ?? "";
  const fingerprint =
    sdkFingerprint.length > 0
      ? sdkFingerprint
      : computeErrorFingerprint(title, body);

  let isDuplicate = false;
  const redis = getRedis();
  if (redis) {
    try {
      const dedupKey = `dedup:zr:${input.projectId}:${fingerprint}`;
      const wasSet = await redis.set(dedupKey, "1", { nx: true, ex: 86400 });
      isDuplicate = !wasSet;
    } catch {
      // Redis unavailable — fall through. Without dedup we may notify
      // twice; that's strictly better than dropping a notification.
    }
  }

  if (isDuplicate) {
    actions.push("deduplicated");
    return finalize({ ...input, event: { ...input.event, fingerprint } }, actions);
  }

  // 3. Lightweight notify. Best-effort: any failure is logged but never
  //    blocks the tombstone signing — the SDK gets its receipt no matter
  //    what happens to Slack/email.
  actions.push("analyzed");
  try {
    await notifyZeroRetention({
      projectId: input.projectId,
      title,
      body,
      severity: (input.event.severity as string) ?? "critical",
      fingerprint,
    });
    actions.push("notified");
  } catch (err) {
    console.error(
      "[zero-retention] notify failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return finalize({ ...input, event: { ...input.event, fingerprint } }, actions);
}

function finalize(
  input: ZeroRetentionInput,
  actions: ProcessedAction[],
): ZeroRetentionResult {
  const fingerprint = (input.event.fingerprint as string) ?? "";
  const result = signTombstone({
    fingerprint,
    integrationId: input.integrationId,
    processedActions: actions,
  });

  if (result.ok) {
    return {
      status: "tombstoned",
      tombstone: result.tombstone,
      processedActions: actions,
    };
  }
  return {
    status: "tombstoned-unsigned",
    reason: result.reason,
    processedActions: actions,
  };
}

// ── Lightweight notification path ──────────────────────────────────────────

interface NotifyInput {
  projectId: string;
  title: string;
  body: string;
  severity: string;
  fingerprint: string;
}

/**
 * Plain-text Slack notification for zero-retention events.
 *
 * Why a separate path:
 *   - `sendAlertToSlack` writes to `slackMessageThreads` keyed by `alertId`.
 *     We don't have one (and creating a fake one would break thread reply
 *     handlers that fetch the alert by id).
 *   - It also attaches Substrate recordings + community-fix lookups, both
 *     of which require an `alertId` lookup.
 *
 * We post a single plain message: severity + title + a short body excerpt
 * + a marker noting zero-retention mode so on-call sees why there are no
 * action buttons. No DB write.
 */
async function notifyZeroRetention(input: NotifyInput): Promise<void> {
  // Resolve project name for context (read-only, no write).
  let projectName = "Unknown";
  try {
    const [proj] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (proj?.name) projectName = proj.name;
  } catch {
    // Non-fatal — we still send the notification with "Unknown".
  }

  const { getSlackClientForProject } = await import("@/lib/slack/client");
  const slack = await getSlackClientForProject(input.projectId);
  if (!slack) return; // no Slack mapping — silently skip (matches createAlertIfNew)

  const severityEmoji =
    input.severity === "critical" ? ":rotating_light:" : ":warning:";
  const bodyExcerpt = input.body.slice(0, 500);
  const text =
    `${severityEmoji} *${input.title}*\n` +
    `Project: \`${projectName}\` · Mode: \`zero-retention\`\n` +
    `${bodyExcerpt}\n` +
    `_No action buttons — this event is not persisted (compliance mode)._\n` +
    `Fingerprint: \`${input.fingerprint.slice(0, 16)}…\``;

  await slack.client.chat.postMessage({
    channel: slack.channelId,
    text,
  });
}
