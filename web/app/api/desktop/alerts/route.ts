import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { db, alerts, projects, apiKeys } from "@/lib/db";
import { eq, desc, inArray } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";

export async function GET(req: NextRequest) {
  // Auth: Bearer <desktop-token>
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = auth.slice(7).trim();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Look up desktop API keys, decrypt, and compare with constant-time check
  const desktopKeys = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.service, "desktop"));

  const keyRow = desktopKeys.find((k) => {
    const stored = Buffer.from(decrypt(k.keyEncrypted ?? ""));
    const provided = Buffer.from(token);
    if (stored.length !== provided.length) return false;
    return crypto.timingSafeEqual(stored, provided);
  });

  if (!keyRow) return NextResponse.json({ error: "Invalid token" }, { status: 401 });

  // Fetch user's projects
  const userProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, keyRow.userId));

  if (userProjects.length === 0) return NextResponse.json([]);

  const projectIds = userProjects.map((p) => p.id);

  // Return recent unread alerts that are critical or warning
  const rows = await db
    .select()
    .from(alerts)
    .where(inArray(alerts.projectId, projectIds))
    .orderBy(desc(alerts.createdAt))
    .limit(20);

  const unread = rows
    .filter((a) => !a.isRead && (a.severity === "critical" || a.severity === "warning"))
    .map((a) => ({
      id:       a.id,
      title:    a.title,
      body:     a.body,
      severity: a.severity,
    }));

  return NextResponse.json(unread);
}
