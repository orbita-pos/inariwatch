import { NextRequest, NextResponse } from "next/server";
import { db, apiKeys, projects, projectIntegrations } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { encrypt, decrypt } from "@/lib/crypto";
import { randomBytes } from "crypto";
import crypto from "crypto";

/**
 * POST /api/cli/link
 *
 * Auth: Bearer <apiToken returned by /api/cli/auth/poll>
 * Body: { projectName: string }
 *
 * Finds or creates a project for this user and a capture integration for it.
 * Returns { dsn, projectName, projectSlug } — the DSN is written to .env by the CLI.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = auth.slice(7).trim();

  // Look up CLI token with constant-time comparison
  const cliKeys = await db.select().from(apiKeys).where(eq(apiKeys.service, "cli"));
  const keyRow  = cliKeys.find((k) => {
    try {
      const stored   = Buffer.from(decrypt(k.keyEncrypted ?? ""));
      const provided = Buffer.from(token);
      if (stored.length !== provided.length) return false;
      return crypto.timingSafeEqual(stored, provided);
    } catch { return false; }
  });

  if (!keyRow) return NextResponse.json({ error: "Invalid token" }, { status: 401 });

  let body: { projectName?: string };
  try { body = await req.json(); } catch { body = {}; }

  const rawName    = (body.projectName ?? "").trim().slice(0, 100);
  const projectName = rawName || "my-project";
  const baseSlug    = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "my-project";

  // Find or create project (by owner + slug)
  let [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, keyRow.userId), eq(projects.slug, baseSlug)))
    .limit(1);

  if (!project) {
    const [slugConflict] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, baseSlug))
      .limit(1);
    const slug = slugConflict ? `${baseSlug}-${randomBytes(3).toString("hex")}` : baseSlug;
    [project] = await db
      .insert(projects)
      .values({ userId: keyRow.userId, name: projectName, slug })
      .returning();
  }

  // Find or create capture integration
  let [integration] = await db
    .select()
    .from(projectIntegrations)
    .where(and(eq(projectIntegrations.projectId, project.id), eq(projectIntegrations.service, "capture")))
    .limit(1);

  let webhookSecret: string;

  if (!integration) {
    webhookSecret  = randomBytes(32).toString("hex");
    [integration] = await db
      .insert(projectIntegrations)
      .values({
        projectId:     project.id,
        service:       "capture",
        webhookSecret: encrypt(webhookSecret),
        isActive:      true,
      })
      .returning();
  } else {
    webhookSecret = integration.webhookSecret ? decrypt(integration.webhookSecret) : "";
    if (!webhookSecret) {
      // Shouldn't happen, but recover gracefully
      webhookSecret = randomBytes(32).toString("hex");
      await db
        .update(projectIntegrations)
        .set({ webhookSecret: encrypt(webhookSecret) })
        .where(eq(projectIntegrations.id, integration.id));
    }
  }

  // DSN format: https://{secret}@host/capture/{integrationId}
  // parseDSN in the capture SDK converts /capture/xxx → /api/webhooks/capture/xxx
  const appUrl = process.env.APP_URL ?? "https://app.inariwatch.com";
  const u      = new URL(appUrl);
  const dsn    = `${u.protocol}//${webhookSecret}@${u.host}/capture/${integration.id}`;

  return NextResponse.json({ dsn, projectName: project.name, projectSlug: project.slug });
}
