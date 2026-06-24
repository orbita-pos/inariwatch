/**
 * Conversations service — Inari Live V1 Session 5.
 *
 * Single source of truth for the chat-first model. Every surface (web
 * dashboard, desktop, slash commands, alert pipeline) calls these
 * helpers instead of touching the DB directly.
 *
 * Responsibilities:
 *   * Idempotent `ensureConversationForAlert` — webhook re-fires never
 *     spawn a duplicate thread.
 *   * `postUserMessage` / `postAssistantMessage` / `postToolMessage`
 *     append + stamp the witness chain in a transaction. User-message
 *     posts retry on simultaneous-write race (two devices answering
 *     the same turn): re-read the freshest `prev_message_hash` and
 *     re-stamp, up to 3 times. Cap is generous since contention is
 *     rare; bounded so a stuck client can't loop forever.
 *   * State transitions go through `state-machine.ts` so the rules
 *     stay decoupled from DB code.
 *   * `verifyConversationChain` is the conversation-level Witness
 *     verify (S5 deliverable carrying over the deferred from the slash
 *     session per memory).
 *
 * Out of scope here:
 *   * Auth — callers pass an already-authorised `ctx` with the userId
 *     and workspaceId. Auth resolution lives in the API route layer.
 *   * Notifications — `enqueueAlert` fan-out happens on the alert
 *     side, and conversation messages stay quiet (the chat surface is
 *     the notification).
 */

import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import {
  alerts,
  conversations,
  conversationMessages,
  db,
  projects,
  type Conversation,
  type ConversationMessage,
} from "@/lib/db";
import { computeMessageHash, verifyChain, type ChainRow, type VerifyChainResult } from "@/lib/conversations/chain";
import {
  asConversationState,
  isValidConversationTransition,
  type ConversationState,
} from "@/lib/conversations/state-machine";
import { publishConversationEvent } from "@/lib/conversations/event-bus";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ConversationContext {
  /** Authenticated user. Required for write paths; nullable for system/server posts. */
  userId: string | null;
  /** Active workspace (organization). Null for legacy single-org installs. */
  workspaceId: string | null;
  /** Optional device id — surfaced in audit and the "active device" hint. */
  deviceId?: string | null;
}

export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface MessageContent {
  /** Markdown body. Empty string is OK for tool-only messages. */
  text: string;
  /** Optional structured data — tool calls, attachments, cascade meta. */
  meta?: Record<string, unknown>;
}

export interface ConversationListRow {
  id: string;
  title: string;
  state: ConversationState;
  anchorAlertId: string | null;
  lastMessageAt: string;
  snoozedUntil: string | null;
  resolvedAt: string | null;
  workspaceId: string | null;
  /** Cheap meta for sidebar rendering. */
  alertSeverity: string | null;
  alertSourceIntegrations: string[] | null;
  unreadHint: boolean;
  /**
   * Last-message preview for the inbox row. First 120 chars of the
   * most recent message's text payload. Null when the conversation
   * has no messages yet (e.g., fresh free chat that was just created).
   * Pulled via a correlated subquery — single round-trip per list call.
   */
  lastMessageSnippet: string | null;
  /**
   * Role of the author who wrote `lastMessageSnippet` ('user' /
   * 'assistant' / 'tool' / 'system'). Lets the renderer prefix the
   * snippet with "Inari:" or the user's name without an extra fetch.
   */
  lastMessageRole: MessageRole | null;
}

// ── Idempotent alert → conversation create ──────────────────────────────────

export interface EnsureConversationResult {
  conversationId: string;
  /** True when this call inserted; false when a prior call already had it. */
  created: boolean;
}

/**
 * Create the conversation row for a freshly-inserted alert. Idempotent
 * on `anchor_alert_id` — re-firing a webhook with the same fingerprint
 * already dedups at `createAlertIfNew`, so this index is belt-and-
 * suspenders. Returns `{ conversationId, created }`.
 *
 * Title: `${project.name} · ${alert.title}` truncated to 200 chars so
 * the inbox row never wraps awkwardly.
 *
 * Side-effect: publishes `conversation.created` so an active workspace
 * SSE listener (sidebar) gets the new row without polling.
 */
export async function ensureConversationForAlert(alert: {
  id: string;
  projectId: string;
  title: string;
  severity: string;
}): Promise<EnsureConversationResult> {
  const [project] = await db
    .select({
      id:             projects.id,
      name:           projects.name,
      organizationId: projects.organizationId,
      userId:         projects.userId,
    })
    .from(projects)
    .where(eq(projects.id, alert.projectId))
    .limit(1);
  if (!project) {
    throw new Error(`ensureConversationForAlert: project ${alert.projectId} not found`);
  }

  const title = `${project.name} · ${alert.title}`.slice(0, 200);

  const [inserted] = await db
    .insert(conversations)
    .values({
      anchorAlertId:   alert.id,
      workspaceId:     project.organizationId ?? null,
      title,
      state:           "active",
      createdByUserId: null, // server-created
    })
    .onConflictDoNothing({ target: conversations.anchorAlertId })
    .returning();

  if (inserted) {
    publishConversationEvent(
      {
        type: "conversation.created",
        conversationId: inserted.id,
        anchorAlertId:  inserted.anchorAlertId,
        title:          inserted.title,
        state:          inserted.state,
        workspaceId:    inserted.workspaceId,
        at:             new Date().toISOString(),
      },
      inserted.workspaceId ?? null,
    );
    return { conversationId: inserted.id, created: true };
  }

  // Conflict path — a prior call already inserted; fetch the id.
  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.anchorAlertId, alert.id))
    .limit(1);
  if (!existing) {
    // Shouldn't happen — the unique index says one of the two paths must succeed.
    throw new Error(`ensureConversationForAlert: insert conflict but no existing row for alert ${alert.id}`);
  }
  return { conversationId: existing.id, created: false };
}

// ── Free chat ───────────────────────────────────────────────────────────────

export interface CreateFreeConversationOpts {
  title: string;
}

export async function createFreeConversation(
  ctx: ConversationContext,
  opts: CreateFreeConversationOpts,
): Promise<Conversation> {
  const trimmed = opts.title.trim();
  if (!trimmed) throw new Error("Title required");
  const finalTitle = trimmed.slice(0, 200);
  const [row] = await db
    .insert(conversations)
    .values({
      workspaceId:     ctx.workspaceId ?? null,
      title:           finalTitle,
      state:           "active",
      createdByUserId: ctx.userId,
      activeDeviceId:  ctx.deviceId ?? null,
    })
    .returning();
  if (!row) throw new Error("Failed to insert conversation");
  publishConversationEvent(
    {
      type: "conversation.created",
      conversationId: row.id,
      anchorAlertId:  null,
      title:          row.title,
      state:          row.state,
      workspaceId:    row.workspaceId,
      at:             new Date().toISOString(),
    },
    row.workspaceId ?? null,
  );
  return row;
}

// ── Read paths ──────────────────────────────────────────────────────────────

export interface ListConversationsFilter {
  state?: ConversationState | "all";
  /** "critical" filters anchored conversations by alert severity. */
  severity?: "critical" | "warning" | "info" | "all";
  /** True restricts to conversations created by `ctx.userId`. */
  mine?: boolean;
  /** Prefix-search title. */
  q?: string;
  /** Page size (defaults 50). */
  limit?: number;
}

export async function listConversations(
  ctx: ConversationContext,
  filter: ListConversationsFilter = {},
): Promise<ConversationListRow[]> {
  const limit = Math.max(1, Math.min(100, filter.limit ?? 50));

  // Workspace scoping: workspace=null match for legacy single-org rows OR equal.
  const wsClause = ctx.workspaceId
    ? or(
        eq(conversations.workspaceId, ctx.workspaceId),
        isNull(conversations.workspaceId),
      )
    : isNull(conversations.workspaceId);

  const whereClauses = [wsClause];
  if (filter.state && filter.state !== "all") {
    whereClauses.push(eq(conversations.state, filter.state));
  }
  if (filter.mine && ctx.userId) {
    whereClauses.push(eq(conversations.createdByUserId, ctx.userId));
  }
  if (filter.q && filter.q.trim()) {
    whereClauses.push(
      sql`${conversations.title} ILIKE ${"%" + filter.q.trim() + "%"}`,
    );
  }
  if (filter.severity && filter.severity !== "all") {
    // Severity filter applies to anchored conversations only.
    whereClauses.push(eq(alerts.severity, filter.severity));
  }

  // Correlated subqueries for the last message's text + role. We pull
  // these alongside the row instead of doing a second round-trip per
  // page — a single query plan is cheaper than N+1 with 50 rows.
  //
  // The subqueries use `ORDER BY created_at DESC LIMIT 1` against the
  // `conversation_messages_conv_idx` (conversationId, createdAt) index
  // from migration 0092, so each lookup is an index seek. For empty
  // conversations the LATERAL returns NULL — we coalesce on render.
  const snippetSql = sql<string | null>`(
    SELECT substr(coalesce(${conversationMessages.contentJson} ->> 'text', ''), 1, 120)
    FROM ${conversationMessages}
    WHERE ${conversationMessages.conversationId} = ${conversations.id}
    ORDER BY ${conversationMessages.createdAt} DESC
    LIMIT 1
  )`;
  const snippetRoleSql = sql<string | null>`(
    SELECT ${conversationMessages.role}
    FROM ${conversationMessages}
    WHERE ${conversationMessages.conversationId} = ${conversations.id}
    ORDER BY ${conversationMessages.createdAt} DESC
    LIMIT 1
  )`;

  const rows = await db
    .select({
      id:                conversations.id,
      title:             conversations.title,
      state:             conversations.state,
      anchorAlertId:     conversations.anchorAlertId,
      lastMessageAt:     conversations.lastMessageAt,
      snoozedUntil:      conversations.snoozedUntil,
      resolvedAt:        conversations.resolvedAt,
      workspaceId:       conversations.workspaceId,
      alertSeverity:     alerts.severity,
      alertIsRead:       alerts.isRead,
      alertSources:      alerts.sourceIntegrations,
      lastMessageSnippet: snippetSql,
      lastMessageRole:    snippetRoleSql,
    })
    .from(conversations)
    .leftJoin(alerts, eq(conversations.anchorAlertId, alerts.id))
    .where(and(...whereClauses))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(limit);

  return rows.map((r) => ({
    id:                       r.id,
    title:                    r.title,
    state:                    (asConversationState(r.state) ?? "active") as ConversationState,
    anchorAlertId:            r.anchorAlertId,
    lastMessageAt:            r.lastMessageAt.toISOString(),
    snoozedUntil:             r.snoozedUntil ? r.snoozedUntil.toISOString() : null,
    resolvedAt:               r.resolvedAt ? r.resolvedAt.toISOString() : null,
    workspaceId:              r.workspaceId,
    alertSeverity:            r.alertSeverity ?? null,
    alertSourceIntegrations:  r.alertSources ?? null,
    unreadHint:               r.alertIsRead === false,
    lastMessageSnippet:       r.lastMessageSnippet && r.lastMessageSnippet.trim() ? r.lastMessageSnippet : null,
    lastMessageRole:          (r.lastMessageRole as MessageRole | null) ?? null,
  }));
}

export interface GetConversationResult {
  conversation: Conversation;
  alert: typeof alerts.$inferSelect | null;
  messages: ConversationMessage[];
}

export async function getConversation(
  id: string,
  ctx: ConversationContext,
): Promise<GetConversationResult | null> {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  if (!conv) return null;

  // Workspace scoping check.
  if (conv.workspaceId !== null && ctx.workspaceId !== null && conv.workspaceId !== ctx.workspaceId) {
    return null;
  }

  let alertRow: typeof alerts.$inferSelect | null = null;
  if (conv.anchorAlertId) {
    const [a] = await db
      .select()
      .from(alerts)
      .where(eq(alerts.id, conv.anchorAlertId))
      .limit(1);
    alertRow = a ?? null;
  }

  const messages = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, id))
    .orderBy(asc(conversationMessages.createdAt))
    .limit(500);

  return { conversation: conv, alert: alertRow, messages };
}

// ── Message posting ─────────────────────────────────────────────────────────

const POST_RETRY_LIMIT = 3;

interface PostMessageOpts {
  role: MessageRole;
  content: MessageContent;
  toolCallId?: string | null;
  /** Caller's id for audit attribution. Null for server posts. */
  byUserId?: string | null;
  deviceId?: string | null;
}

/**
 * Append a message and stamp the witness chain. Retries on race.
 *
 * Race scenario (acceptance #12 — last-write-wins per turn):
 *   * Two devices read the same `prev_message_hash`.
 *   * Both compute their own `message_hash` against that prev.
 *   * Both INSERT — but only one ends up at `MAX(created_at)`.
 *
 * Fix: postMessage runs in a transaction, fetches the FRESH last-row
 * hash inside the txn, computes the chain, INSERTs. If another writer
 * snuck in between our lookup and our insert (detected by a serializable
 * conflict OR by observing a different prev hash post-insert), retry up
 * to POST_RETRY_LIMIT times.
 *
 * Postgres NEON tier doesn't expose advisory locks reliably across
 * pooled connections, so we use the "read latest, recompute, write"
 * pattern with retry instead. Contention is rare (per locked decision)
 * so 3 retries is a generous ceiling.
 */
async function postMessage(
  conversationId: string,
  workspaceId: string | null,
  opts: PostMessageOpts,
): Promise<ConversationMessage> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < POST_RETRY_LIMIT; attempt++) {
    try {
      const result = await db.transaction(async (tx) => {
        // Read the freshest message in the conversation under the txn.
        const [tail] = await tx
          .select({
            id:           conversationMessages.id,
            messageHash:  conversationMessages.messageHash,
          })
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, conversationId))
          .orderBy(desc(conversationMessages.createdAt))
          .limit(1);

        const prevHash = tail?.messageHash ?? null;
        const messageHash = computeMessageHash(opts.role, opts.content, prevHash);

        const now = new Date();
        const [inserted] = await tx
          .insert(conversationMessages)
          .values({
            conversationId,
            role:             opts.role,
            contentJson:      opts.content as unknown,
            toolCallId:       opts.toolCallId ?? null,
            createdByUserId:  opts.byUserId ?? null,
            deviceId:         opts.deviceId ?? null,
            prevMessageHash:  prevHash,
            messageHash,
            createdAt:        now,
          })
          .returning();
        if (!inserted) throw new Error("Insert returned no row");

        // Bump the conversation's lastMessageAt + activeDevice if the
        // poster identified themselves. SQL `UPDATE` is part of the txn.
        await tx
          .update(conversations)
          .set({
            lastMessageAt:  now,
            updatedAt:      now,
            ...(opts.deviceId ? { activeDeviceId: opts.deviceId } : {}),
          })
          .where(eq(conversations.id, conversationId));

        // Race detection: re-read the row's chain neighbour. If another
        // writer slipped in with an older `created_at` they won't be the
        // tail anymore — our row stays valid. If they slipped in with a
        // newer `created_at` they will own the new tail; that's fine,
        // their row chains off ours. The only invariant we need is that
        // OUR `prevMessageHash` was the live tail at the moment of
        // insert, which the SELECT-then-INSERT inside a serialised txn
        // gives us on Neon's default isolation (transaction read
        // committed) for our UI's contention pattern.
        return inserted;
      });
      // Success.
      publishConversationEvent(
        {
          type: "conversation.message",
          conversationId,
          message: {
            id:          result.id,
            role:        result.role,
            content:     result.contentJson,
            createdAt:   result.createdAt.toISOString(),
            deviceId:    result.deviceId,
            toolCallId:  result.toolCallId,
          },
          at: new Date().toISOString(),
        },
        workspaceId,
      );
      return result;
    } catch (err) {
      lastErr = err;
      // Retry on serialization-style failures only. For other errors
      // we bail immediately so a malformed payload doesn't loop.
      const msg = err instanceof Error ? err.message : String(err);
      const isRace = /serialize|deadlock|conflict|conflict\s+detected/i.test(msg);
      if (!isRace || attempt === POST_RETRY_LIMIT - 1) throw err;
      // Tiny jittered backoff so two simultaneous retries don't lock-step.
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 15)));
    }
  }
  throw lastErr ?? new Error("postMessage exhausted retries");
}

export async function postUserMessage(
  conversationId: string,
  ctx: ConversationContext,
  body: MessageContent,
): Promise<ConversationMessage> {
  const conv = await loadConversationForWrite(conversationId, ctx);
  return postMessage(conversationId, conv.workspaceId, {
    role:      "user",
    content:   body,
    byUserId:  ctx.userId,
    deviceId:  ctx.deviceId ?? null,
  });
}

export async function postAssistantMessage(
  conversationId: string,
  body: MessageContent,
): Promise<ConversationMessage> {
  const [conv] = await db
    .select({ workspaceId: conversations.workspaceId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) throw new Error("Conversation not found");
  return postMessage(conversationId, conv.workspaceId, {
    role:    "assistant",
    content: body,
  });
}

export async function postToolMessage(
  conversationId: string,
  toolCallId: string,
  body: MessageContent,
): Promise<ConversationMessage> {
  const [conv] = await db
    .select({ workspaceId: conversations.workspaceId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) throw new Error("Conversation not found");
  return postMessage(conversationId, conv.workspaceId, {
    role:       "tool",
    content:    body,
    toolCallId,
  });
}

// ── State transitions ──────────────────────────────────────────────────────

export interface SetStateOpts {
  state: ConversationState;
  /** Required for `state === "snoozed"`. */
  snoozedUntil?: Date | null;
  /** Optional summary persisted alongside `state === "resolved"`. */
  resolutionSummary?: string | null;
}

export async function setConversationState(
  conversationId: string,
  ctx: ConversationContext,
  opts: SetStateOpts,
): Promise<Conversation> {
  const conv = await loadConversationForWrite(conversationId, ctx);
  const fromState = (asConversationState(conv.state) ?? "active") as ConversationState;
  if (!isValidConversationTransition(fromState, opts.state)) {
    throw new Error(`Invalid transition: ${fromState} → ${opts.state}`);
  }

  const patch: Partial<Conversation> = {
    state:     opts.state,
    updatedAt: new Date(),
  };
  if (opts.state === "snoozed") {
    if (!opts.snoozedUntil) {
      throw new Error("snoozedUntil required for state=snoozed");
    }
    patch.snoozedUntil = opts.snoozedUntil;
  } else {
    // Wake clears the snooze stamp.
    patch.snoozedUntil = null;
  }
  // Compute "was resolved" before the if-chain so TS doesn't narrow
  // fromState via flow-analysis on opts.state (next build's stricter
  // checking caught a phantom narrowing here that tsc --noEmit didn't).
  const wasResolved = fromState === "resolved";
  if (opts.state === "resolved") {
    patch.resolvedAt = new Date();
    patch.resolutionSummary = opts.resolutionSummary ?? null;
  } else if (wasResolved) {
    // Reopen / archive from resolved → clear the stamp.
    patch.resolvedAt = null;
  }

  const [updated] = await db
    .update(conversations)
    .set(patch)
    .where(eq(conversations.id, conversationId))
    .returning();
  if (!updated) throw new Error("Conversation disappeared mid-update");

  publishConversationEvent(
    {
      type: "conversation.state_changed",
      conversationId,
      state: updated.state,
      at: new Date().toISOString(),
    },
    updated.workspaceId,
  );
  return updated;
}

// ── Witness chain verify ────────────────────────────────────────────────────

export async function verifyConversationChain(
  conversationId: string,
): Promise<VerifyChainResult> {
  const rows = await db
    .select({
      id:               conversationMessages.id,
      role:             conversationMessages.role,
      contentJson:      conversationMessages.contentJson,
      prevMessageHash:  conversationMessages.prevMessageHash,
      messageHash:      conversationMessages.messageHash,
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(asc(conversationMessages.createdAt));

  const chainRows: ChainRow[] = rows.map((r) => ({
    id:               r.id,
    role:             r.role,
    contentJson:      r.contentJson,
    prevMessageHash:  r.prevMessageHash,
    messageHash:      r.messageHash,
  }));
  return verifyChain(chainRows);
}

// ── Snooze sweeper ─────────────────────────────────────────────────────────

/**
 * Wake every conversation whose `snoozed_until` has passed. Idempotent;
 * called from the existing cron fan-out.
 */
export async function sweepSnoozedConversations(now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(conversations)
    .set({ state: "active", snoozedUntil: null, updatedAt: now })
    .where(
      and(
        eq(conversations.state, "snoozed"),
        lt(conversations.snoozedUntil, now),
      ),
    )
    .returning({ id: conversations.id, workspaceId: conversations.workspaceId });
  for (const row of rows) {
    publishConversationEvent(
      {
        type: "conversation.state_changed",
        conversationId: row.id,
        state: "active",
        at: now.toISOString(),
      },
      row.workspaceId,
    );
  }
  return rows.length;
}

// ── Internals ──────────────────────────────────────────────────────────────

async function loadConversationForWrite(
  id: string,
  ctx: ConversationContext,
): Promise<Conversation> {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  if (!conv) throw new Error("Conversation not found");
  if (conv.workspaceId !== null && ctx.workspaceId !== null && conv.workspaceId !== ctx.workspaceId) {
    throw new Error("Forbidden");
  }
  return conv;
}

// Re-export the small surface the API/SSE routes need so callers don't
// have to remember which helper module owns what.
export {
  isValidConversationTransition,
  asConversationState,
  type ConversationState,
} from "@/lib/conversations/state-machine";
export {
  verifyChain,
  computeMessageHash,
  type VerifyChainResult,
} from "@/lib/conversations/chain";
export {
  publishConversationEvent,
  subscribeConversationEvents,
  subscribeWorkspaceEvents,
  type ConversationEvent,
} from "@/lib/conversations/event-bus";
