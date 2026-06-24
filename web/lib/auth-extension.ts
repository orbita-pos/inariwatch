import crypto from "crypto"
import { db, projects, apiKeys, deviceTokens } from "@/lib/db"
import { and, eq, isNull, sql } from "drizzle-orm"
import { decrypt } from "@/lib/crypto"
import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Constant-time string comparison — pads to equal length to prevent length leaking */
function constantTimeCompare(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length)
  const aBuf = Buffer.alloc(maxLen)
  const bBuf = Buffer.alloc(maxLen)
  Buffer.from(a).copy(aBuf)
  Buffer.from(b).copy(bBuf)
  return crypto.timingSafeEqual(aBuf, bBuf)
}

export interface AuthResult {
  userId: string
  projectIds: string[]
  /** Set when the bearer matches a Session-1 device_tokens row. */
  deviceId?: string
}

/**
 * Authenticate extension/desktop Bearer token. Returns null if invalid.
 *
 * Lookup order:
 *   1. device_tokens by token_hash (Session 1 — multi-device, O(1)).
 *   2. api_keys with service='desktop' fallback (pre-S1 installs).
 *
 * The legacy fallback stays so users who paired before S1 keep working
 * until they re-pair. Drop in a follow-up after telemetry confirms the
 * cohort has rotated.
 */
export async function authenticateExtensionToken(req: NextRequest): Promise<AuthResult | null> {
  const auth = req.headers.get("authorization") ?? ""
  if (!auth.startsWith("Bearer ")) return null
  const token = auth.slice(7).trim()
  if (!token) return null

  // ── Hot path: Session 1 device_tokens by hash ──
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex")
  const [deviceRow] = await db
    .select({
      deviceId: deviceTokens.deviceId,
      userId:   deviceTokens.userId,
    })
    .from(deviceTokens)
    .where(and(eq(deviceTokens.tokenHash, tokenHash), isNull(deviceTokens.revokedAt)))
    .limit(1)

  if (deviceRow) {
    // Best-effort last-seen bump — never blocks the request, swallow errors.
    void (async () => {
      try {
        await db
          .update(deviceTokens)
          .set({ lastSeenAt: sql`now()` })
          .where(eq(deviceTokens.deviceId, deviceRow.deviceId))
      } catch {
        /* auth already succeeded; last-seen bump failures are non-fatal */
      }
    })()

    const userProjects = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.userId, deviceRow.userId))

    return {
      userId:     deviceRow.userId,
      deviceId:   deviceRow.deviceId,
      projectIds: userProjects.map((p) => p.id),
    }
  }

  // ── Legacy fallback: api_keys.service='desktop' (pre-S1 installs) ──
  const keys = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.service, "desktop"))

  const keyRow = keys.find((k) => {
    const stored = decrypt(k.keyEncrypted ?? "")
    return constantTimeCompare(stored, token)
  })

  if (!keyRow) return null

  const userProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, keyRow.userId))

  return {
    userId:     keyRow.userId,
    projectIds: userProjects.map((p) => p.id),
  }
}

/** Validate that a string is a valid UUID */
export function isValidUUID(id: string): boolean {
  return UUID_RE.test(id)
}

/** Standard 401 response */
export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

/** Standard 403 response */
export function forbidden(msg = "Forbidden") {
  return NextResponse.json({ error: msg }, { status: 403 })
}

/** Standard 400 response */
export function badRequest(msg = "Bad request") {
  return NextResponse.json({ error: msg }, { status: 400 })
}

/**
 * Resolve the calling user via either a Session-1 device-token Bearer or
 * a NextAuth session cookie. Used by /api/desktop/devices/* so the same
 * route serves the desktop app and the web Settings panel.
 */
export async function resolveDesktopActor(
  req: NextRequest,
): Promise<{ userId: string; deviceId?: string } | null> {
  const bearer = await authenticateExtensionToken(req)
  if (bearer) return { userId: bearer.userId, deviceId: bearer.deviceId }

  const session = await getServerSession(authOptions)
  const userId  = (session?.user as { id?: string } | undefined)?.id
  return userId ? { userId } : null
}
