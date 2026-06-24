/**
 * Project token service — Inari Live V1 Session 2.
 *
 * Lifecycle owner for `project_tokens` rows. Mint, rotate, revoke, list,
 * lookup-by-token. Plaintext token NEVER leaves this module after the
 * single mint response — only the SHA-256 hash is persisted, only the
 * 18-char prefix is queryable for display. Loss of the plaintext means
 * the user must rotate (the recovery decision in INARI_LIVE_V1_PLAN.md).
 *
 * Token format: `iwk_pub_v1_<base64url(32 random bytes)>`. Prefix is
 * registrable in the GitHub Secret Scanning Partner Program (Session 7
 * deliverable). The format intentionally fits the legacy DSN URL —
 * `https://iwk_pub_v1_xxx@host/capture/<projectId>` — so the existing
 * capture/src/transport.ts parser extracts it as `secretKey` without
 * needing a parallel parser.
 *
 * Auth modes the capture webhook supports (see web/lib/webhooks/shared.ts):
 *   1. token mode — `Authorization: Bearer iwk_pub_v1_…`. Stateless,
 *      bearer-only, no body HMAC. The server SHA-256s the token and
 *      looks up `project_tokens.token_hash`.
 *   2. legacy DSN mode — `x-capture-signature: sha256=hmac(secret, body)`.
 *      Untouched. The two modes coexist per project — a project may have
 *      a legacy `project_integrations.webhookSecret` AND any number of
 *      `project_tokens` rows, and capture webhook resolves which path to
 *      take per request.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  db,
  projects,
  projectTokens,
  type ProjectToken,
} from "@/lib/db";

// ── Constants ────────────────────────────────────────────────────────────────

/** Public token prefix. Registered with GitHub Secret Scanning Partner Program
 *  (Session 7). Changing this is a wire-format break — do not bump the version
 *  in place; emit a new prefix and accept both during the migration window. */
export const TOKEN_PREFIX = "iwk_pub_v1_";

/** Length of the random body in bytes (256 bits — matches mcp_tokens entropy). */
export const TOKEN_BYTES = 32;

/** Length of the displayable fingerprint (prefix + first 7 random chars) used
 *  by the dashboard UI. Long enough to disambiguate dozens of tokens per
 *  project, short enough that a screenshot doesn't leak the secret. */
export const FINGERPRINT_LEN = 18;

/** 24h grace window for rotated tokens. The rotate-grace cron sweeps
 *  tokens with `rotated_to IS NOT NULL AND created_at < now()-24h` and
 *  flips their revoked_at to the current timestamp. */
export const ROTATE_GRACE_MS = 24 * 60 * 60 * 1000;

// ── Token primitives ────────────────────────────────────────────────────────

/** Generate a fresh plaintext token. Pure — no DB. */
export function generateTokenPlaintext(): string {
  // base64url is URL-safe and DSN-compatible — no `+`/`/`/`=` to escape when
  // embedded in `https://<token>@host/...`.
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
}

/** SHA-256 the plaintext to its hex digest — what gets stored in token_hash. */
export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Display fingerprint shown in lists (`iwk_pub_v1_aB3xY9k`). Never the secret. */
export function tokenFingerprint(plaintext: string): string {
  return plaintext.slice(0, FINGERPRINT_LEN);
}

/** Cheap membership check before a DB hit — caller can short-circuit. */
export function looksLikeProjectToken(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  if (!value.startsWith(TOKEN_PREFIX)) return false;
  // 32-byte base64url is 43 chars unpadded; total = prefix(11) + 43 = 54.
  // Allow ±2 to absorb any future entropy bump without a hard recompile.
  return value.length >= TOKEN_PREFIX.length + 40 && value.length <= TOKEN_PREFIX.length + 60;
}

// ── DSN URL emission (backwards-compat with capture/src/transport.ts) ───────

function appHost(): string {
  const raw =
    process.env.APP_URL ??
    process.env.NEXTAUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "https://app.inariwatch.com";
  return raw.replace(/\/$/, "");
}

/**
 * Format a token as a legacy-style DSN URL so existing capture installs
 * (which parse `https://<secret>@host/capture/<id>`) accept it without
 * code changes. The path segment is the projectId — capture webhook
 * sees the Bearer-style secret in `url.username`, recognises the prefix,
 * and routes via loadIntegrationByToken instead of loadIntegration.
 */
export function tokenToDSN(plaintext: string, projectId: string): string {
  return `${appHost()}/capture/${projectId}`.replace(
    /^https?:\/\//,
    (m) => `${m}${plaintext}@`,
  );
}

// ── Service surface ─────────────────────────────────────────────────────────

export interface MintInput {
  projectId:    string;
  /** Pulled from projects.organization_id at mint time. NULL for personal. */
  workspaceId:  string | null;
  createdVia:   "web" | "desktop" | "cli" | "api";
  createdBy:    string | null;
  deviceLabel?: string | null;
  scope?:       string[];
}

export interface MintResult {
  id:          string;
  /** PLAINTEXT — return value only, never persisted, never returned again. */
  token:       string;
  fingerprint: string;
  /** Backwards-compat DSN URL the SDK can use today without code changes. */
  dsn:         string;
  createdAt:   Date;
  scope:       string[];
}

/**
 * Mint a fresh token. Plaintext is in the return value only; everything in
 * Postgres is the SHA-256 hash + 18-char prefix. The caller is responsible
 * for forgetting the plaintext after handing it to the user.
 */
export async function mintToken(input: MintInput): Promise<MintResult> {
  const plaintext   = generateTokenPlaintext();
  const tokenHash   = hashToken(plaintext);
  const tokenPrefix = tokenFingerprint(plaintext);
  const scope       = input.scope && input.scope.length > 0 ? input.scope : ["events:write"];

  const [row] = await db
    .insert(projectTokens)
    .values({
      projectId:   input.projectId,
      workspaceId: input.workspaceId,
      tokenHash,
      tokenPrefix,
      scope,
      createdVia:  input.createdVia,
      createdBy:   input.createdBy,
      deviceLabel: input.deviceLabel ?? null,
    })
    .returning();

  if (!row) {
    throw new Error("project_tokens insert returned no row");
  }

  return {
    id:          row.id,
    token:       plaintext,
    fingerprint: row.tokenPrefix,
    dsn:         tokenToDSN(plaintext, input.projectId),
    createdAt:   row.createdAt,
    scope:       row.scope,
  };
}

/**
 * Resolve a project's workspace_id — convenience for routes that only have
 * the projectId in their URL params. Returns `null` for personal projects.
 */
export async function getProjectWorkspaceId(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.organizationId ?? null;
}

export interface ListedToken {
  id:          string;
  fingerprint: string;
  scope:       string[];
  createdAt:   Date;
  lastUsedAt:  Date | null;
  revokedAt:   Date | null;
  rotatedTo:   string | null;
  createdVia:  string;
  deviceLabel: string | null;
}

/** List tokens for a project — fingerprints only, no hash, no plaintext. */
export async function listTokens(projectId: string): Promise<ListedToken[]> {
  const rows = await db
    .select({
      id:          projectTokens.id,
      fingerprint: projectTokens.tokenPrefix,
      scope:       projectTokens.scope,
      createdAt:   projectTokens.createdAt,
      lastUsedAt:  projectTokens.lastUsedAt,
      revokedAt:   projectTokens.revokedAt,
      rotatedTo:   projectTokens.rotatedTo,
      createdVia:  projectTokens.createdVia,
      deviceLabel: projectTokens.deviceLabel,
    })
    .from(projectTokens)
    .where(eq(projectTokens.projectId, projectId))
    .orderBy(desc(projectTokens.createdAt));
  return rows;
}

export interface RotateInput {
  projectId:    string;
  oldTokenId:   string;
  workspaceId:  string | null;
  createdVia:   "web" | "desktop" | "cli" | "api";
  createdBy:    string | null;
  deviceLabel?: string | null;
}

export interface RotateResult extends MintResult {
  /** ID of the token being replaced. Old token still works for 24h grace. */
  supersedes:  string;
  /** ISO timestamp when the cron grace sweep will revoke the old token. */
  graceEndsAt: string;
}

/**
 * Rotate a token. Mints a fresh row + sets `old.rotated_to = new.id`.
 * Both tokens validate during the 24h grace window — see
 * `web/app/api/cron/rotate-grace/route.ts` for the auto-revoke sweep.
 *
 * Idempotent on a freshly-rotated old token: refuses to rotate one that is
 * already linked or revoked, since otherwise the chain becomes ambiguous.
 */
export async function rotateToken(input: RotateInput): Promise<RotateResult> {
  const [old] = await db
    .select({
      id:        projectTokens.id,
      projectId: projectTokens.projectId,
      revokedAt: projectTokens.revokedAt,
      rotatedTo: projectTokens.rotatedTo,
    })
    .from(projectTokens)
    .where(
      and(
        eq(projectTokens.id, input.oldTokenId),
        eq(projectTokens.projectId, input.projectId),
      ),
    )
    .limit(1);

  if (!old) {
    throw new ProjectTokenError("token_not_found", "Token does not belong to this project");
  }
  if (old.revokedAt) {
    throw new ProjectTokenError("token_revoked", "Token is already revoked — mint a fresh one instead");
  }
  if (old.rotatedTo) {
    throw new ProjectTokenError("token_already_rotated", "Token has already been rotated");
  }

  const fresh = await mintToken({
    projectId:   input.projectId,
    workspaceId: input.workspaceId,
    createdVia:  input.createdVia,
    createdBy:   input.createdBy,
    deviceLabel: input.deviceLabel ?? null,
  });

  await db
    .update(projectTokens)
    .set({ rotatedTo: fresh.id })
    .where(eq(projectTokens.id, old.id));

  return {
    ...fresh,
    supersedes:  old.id,
    graceEndsAt: new Date(fresh.createdAt.getTime() + ROTATE_GRACE_MS).toISOString(),
  };
}

export interface RevokeInput {
  projectId: string;
  tokenId:   string;
}

export interface RevokeResult {
  id:        string;
  revokedAt: Date;
}

/**
 * Hard-revoke a token. No grace window — the next capture request bearing
 * this token will 401 immediately. Used by the user manually + by the
 * GitHub Secret Scanning webhook handler (Session 7).
 *
 * Idempotent: revoking an already-revoked token returns the existing
 * revoked_at without raising.
 */
export async function revokeToken(input: RevokeInput): Promise<RevokeResult> {
  const [existing] = await db
    .select({
      id:        projectTokens.id,
      revokedAt: projectTokens.revokedAt,
    })
    .from(projectTokens)
    .where(
      and(
        eq(projectTokens.id, input.tokenId),
        eq(projectTokens.projectId, input.projectId),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new ProjectTokenError("token_not_found", "Token does not belong to this project");
  }
  if (existing.revokedAt) {
    return { id: existing.id, revokedAt: existing.revokedAt };
  }

  const now = new Date();
  await db
    .update(projectTokens)
    .set({ revokedAt: now })
    .where(eq(projectTokens.id, existing.id));

  return { id: existing.id, revokedAt: now };
}

// ── Lookup (called from the capture webhook) ────────────────────────────────

export interface ProjectTokenLookup {
  tokenId:     string;
  projectId:   string;
  workspaceId: string | null;
  scope:       string[];
  rotatedTo:   string | null;
}

/**
 * Look up a project token by its plaintext value. Returns null if the token
 * doesn't exist or has been revoked. Does NOT enforce the rotate grace —
 * that happens implicitly: a rotated-but-not-yet-revoked token still lives
 * in the table until the cron sweeps it 24h later, so this lookup keeps
 * accepting it as long as `revoked_at IS NULL`.
 *
 * Side effect: bumps `last_used_at` best-effort (fire-and-forget). A failure
 * to update the timestamp must not 401 the request — the lookup result is
 * authoritative.
 */
export async function loadProjectByToken(plaintext: string): Promise<ProjectTokenLookup | null> {
  if (!looksLikeProjectToken(plaintext)) return null;
  const tokenHash = hashToken(plaintext);

  const [row] = await db
    .select({
      tokenId:     projectTokens.id,
      projectId:   projectTokens.projectId,
      workspaceId: projectTokens.workspaceId,
      scope:       projectTokens.scope,
      revokedAt:   projectTokens.revokedAt,
      rotatedTo:   projectTokens.rotatedTo,
    })
    .from(projectTokens)
    .where(eq(projectTokens.tokenHash, tokenHash))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt) return null;

  // Best-effort last-used bump. Don't block the alert path on it.
  void db
    .update(projectTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(projectTokens.id, row.tokenId))
    .catch(() => undefined);

  return {
    tokenId:     row.tokenId,
    projectId:   row.projectId,
    workspaceId: row.workspaceId,
    scope:       row.scope,
    rotatedTo:   row.rotatedTo,
  };
}

// ── Cron sweep — auto-revoke rotated tokens past 24h grace ──────────────────

export interface GraceSweepResult {
  revoked: number;
}

/**
 * Auto-revoke rotated tokens whose 24h grace window has elapsed.
 * Called by the rotate-grace cron route. Idempotent — re-running after a
 * sweep is a no-op for already-revoked rows.
 */
export async function sweepRotateGrace(now: Date = new Date()): Promise<GraceSweepResult> {
  const cutoff = new Date(now.getTime() - ROTATE_GRACE_MS);
  const updated = await db
    .update(projectTokens)
    .set({ revokedAt: now })
    .where(
      and(
        sql`${projectTokens.rotatedTo} IS NOT NULL`,
        isNull(projectTokens.revokedAt),
        lt(projectTokens.createdAt, cutoff),
      ),
    )
    .returning({ id: projectTokens.id });
  return { revoked: updated.length };
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class ProjectTokenError extends Error {
  constructor(
    public code:
      | "token_not_found"
      | "token_revoked"
      | "token_already_rotated",
    message: string,
  ) {
    super(message);
    this.name = "ProjectTokenError";
  }
}

// Re-export Drizzle row types for callers that need them.
export type { ProjectToken };
