import crypto from "crypto"
import { db, projects, apiKeys } from "@/lib/db"
import { eq } from "drizzle-orm"
import { decrypt } from "@/lib/crypto"
import { NextRequest, NextResponse } from "next/server"

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
}

/** Authenticate extension/desktop Bearer token. Returns null if invalid. */
export async function authenticateExtensionToken(req: NextRequest): Promise<AuthResult | null> {
  const auth = req.headers.get("authorization") ?? ""
  if (!auth.startsWith("Bearer ")) return null
  const token = auth.slice(7).trim()
  if (!token) return null

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
    userId: keyRow.userId,
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
