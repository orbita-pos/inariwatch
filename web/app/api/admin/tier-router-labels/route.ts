import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, tierRouterLabels, users } from "@/lib/db";
import { eq, sql } from "drizzle-orm";

const VALID_TIERS = new Set(["0", "1", "2", "3"]);

async function requireAdminUserId(): Promise<{ userId: string } | { error: string; status: number }> {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string })?.email ?? null;
  if (!email || email !== process.env.ADMIN_EMAIL) {
    return { error: "Unauthorized", status: 401 };
  }
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!u) return { error: "Admin user row missing", status: 500 };
  return { userId: u.id };
}

export async function POST(req: Request) {
  const auth = await requireAdminUserId();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: { sessionId?: string; humanTier?: string; notes?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId, humanTier, notes } = body;
  if (!sessionId || typeof sessionId !== "string") {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }
  if (!humanTier || !VALID_TIERS.has(humanTier)) {
    return NextResponse.json({ error: "humanTier must be one of 0|1|2|3" }, { status: 400 });
  }

  await db.execute(sql`
    INSERT INTO tier_router_labels (session_id, labeler_user_id, human_tier, notes)
    VALUES (${sessionId}::uuid, ${auth.userId}::uuid, ${humanTier}, ${notes ?? null})
    ON CONFLICT (session_id, labeler_user_id)
    DO UPDATE SET human_tier = EXCLUDED.human_tier, notes = EXCLUDED.notes, created_at = now()
  `);

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const auth = await requireAdminUserId();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });

  await db
    .delete(tierRouterLabels)
    .where(sql`session_id = ${sessionId}::uuid AND labeler_user_id = ${auth.userId}::uuid`);
  return NextResponse.json({ ok: true });
}
