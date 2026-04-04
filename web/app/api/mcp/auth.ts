import { db, mcpTokens, auditLogs, apiKeys } from "@/lib/db";
import { eq, and, or, gt, isNull } from "drizzle-orm";
import { rateLimit } from "@/lib/auth-rate-limit";
import { createHash, timingSafeEqual } from "crypto";
import { decrypt } from "@/lib/crypto";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type McpUser = {
  userId: string;
  tokenId: string;
  scopes: string[];
};

// ── Granular scopes ─────────────────────────────────────────────────────────

/**
 * Scope hierarchy: execute > write > read
 * Granular scopes: alerts:read, alerts:write, remediation:execute, etc.
 * Shorthand scopes: "read" = all read, "write" = all read+write, "execute" = all
 */
const SCOPE_HIERARCHY: Record<string, string[]> = {
  execute: ["execute", "write", "read"],
  write: ["write", "read"],
  read: ["read"],
};

export function hasScope(userScopes: string[], requiredScope: string): boolean {
  for (const s of userScopes) {
    // Shorthand: "execute" covers everything
    if (SCOPE_HIERARCHY[s]?.includes(requiredScope)) return true;
    // Granular: "alerts:read" matches "read" scope requirement
    if (s === requiredScope) return true;
    // Granular with hierarchy: "alerts:write" covers "alerts:read"
    const [resource, level] = s.split(":");
    const [reqResource, reqLevel] = requiredScope.split(":");
    if (resource && level && reqResource && reqLevel) {
      if (resource === reqResource && SCOPE_HIERARCHY[level]?.includes(reqLevel)) return true;
    }
  }
  return false;
}

// ── Authentication ──────────────────────────────────────────────────────────

export async function authenticateMcp(
  request: Request
): Promise<McpUser | null> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;

  const token = auth.slice(7).trim();
  if (!token) return null;

  // Try MCP tokens first (inari_ prefix, hashed)
  if (token.startsWith("inari_")) {
    const hash = hashToken(token);

    const [row] = await db
      .select()
      .from(mcpTokens)
      .where(
        and(
          eq(mcpTokens.tokenHash, hash),
          or(isNull(mcpTokens.expiresAt), gt(mcpTokens.expiresAt, new Date()))
        )
      )
      .limit(1);

    if (row) {
      db.update(mcpTokens).set({ lastUsedAt: new Date() }).where(eq(mcpTokens.id, row.id)).then(() => {}).catch(() => {});
      return { userId: row.userId, tokenId: row.id, scopes: row.scopes ?? ["read"] };
    }
  }

  // Fallback: check apiKeys by hash (for CLI/mobile/desktop tokens)
  try {
    const keyHash = hashToken(token);
    const [keyRow] = await db.select().from(apiKeys).where(
      and(
        eq(apiKeys.keyHash, keyHash),
        or(eq(apiKeys.service, "cli"), eq(apiKeys.service, "mobile"), eq(apiKeys.service, "desktop"))
      )
    ).limit(1);

    if (keyRow) {
      return { userId: keyRow.userId, tokenId: keyRow.id, scopes: ["execute"] };
    }

    // Legacy fallback for tokens created before keyHash migration (O(n) — remove after backfill)
    const legacyKeys = await db.select().from(apiKeys).where(
      and(
        isNull(apiKeys.keyHash),
        or(eq(apiKeys.service, "cli"), eq(apiKeys.service, "mobile"), eq(apiKeys.service, "desktop"))
      )
    );
    for (const key of legacyKeys) {
      try {
        const decrypted = decrypt(key.keyEncrypted);
        if (decrypted.length === token.length && timingSafeEqual(Buffer.from(decrypted), Buffer.from(token))) {
          // Backfill hash for next time
          db.update(apiKeys).set({ keyHash }).where(eq(apiKeys.id, key.id)).catch(() => {});
          return { userId: key.userId, tokenId: key.id, scopes: ["execute"] };
        }
      } catch { /* skip corrupt keys */ }
    }
  } catch {
    // apiKeys fallback failed — return null
  }

  return null;
}

// ── Rate limiting ───────────────────────────────────────────────────────────

/**
 * Rate limit MCP calls per token.
 * Default: 200 calls/minute (generous for AI tools that batch calls).
 */
export async function checkMcpRateLimit(
  key: string,
  limits?: { windowMs: number; max: number }
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  return rateLimit("mcp", key, limits ?? { windowMs: 60_000, max: 200 });
}

// ── Audit logging ───────────────────────────────────────────────────────────

export async function logMcpCall(
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
  result: { ok: boolean; latencyMs: number; error?: string }
): Promise<void> {
  // Deep redact sensitive fields from args
  const SENSITIVE = new Set(["token", "key", "secret", "password", "api_key", "apiKey", "access_token", "authorization", "credentials"]);
  function redact(obj: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE.has(k.toLowerCase())) { safe[k] = "[REDACTED]"; continue; }
      if (v && typeof v === "object" && !Array.isArray(v)) { safe[k] = redact(v as Record<string, unknown>); continue; }
      safe[k] = v;
    }
    return safe;
  }
  const safeArgs = redact(args);

  try {
    await db.insert(auditLogs).values({
      userId,
      action: `mcp.${toolName}`,
      resource: "mcp",
      metadata: {
        tool: toolName,
        args: safeArgs,
        ok: result.ok,
        latencyMs: result.latencyMs,
        ...(result.error ? { error: result.error.slice(0, 500) } : {}),
      },
    });
  } catch {
    // Audit logging should never break the request
  }
}
