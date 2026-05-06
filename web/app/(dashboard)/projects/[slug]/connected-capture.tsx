import { and, eq } from "drizzle-orm";
import { db, projectIntegrations } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { ConnectedCaptureClient } from "./connected-capture-client";

function appHost(): string {
  const raw =
    process.env.APP_URL ??
    process.env.NEXTAUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "https://app.inariwatch.com";
  return raw.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * Per-project Capture SDK section.
 *
 * Replaces the global /integrations card after the 2026-05-05 sole-integration
 * cut: Capture is the project's runtime-error stream, not a third-party
 * service, so it lives next to the connected GitHub repo. The DSN is
 * project-scoped (one webhookSecret per projectIntegrations row), matching
 * what the SDK at `web/api/webhooks/capture/[integrationId]` already verifies.
 */
export async function ConnectedCaptureSection({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const [row] = await db
    .select({
      id: projectIntegrations.id,
      isActive: projectIntegrations.isActive,
      webhookSecret: projectIntegrations.webhookSecret,
    })
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.service, "capture"),
      ),
    )
    .limit(1);

  let dsnFull: string | null = null;
  let dsnMasked: string | null = null;
  if (row?.webhookSecret) {
    const secret = decrypt(row.webhookSecret);
    const host = appHost();
    dsnFull = `https://${secret}@${host}/capture/${row.id}`;
    dsnMasked = `https://${secret.slice(0, 8)}${"•".repeat(20)}@${host}/capture/${row.id}`;
  }

  return (
    <ConnectedCaptureClient
      projectId={projectId}
      isAdmin={isAdmin}
      enabled={!!row && row.isActive}
      dsnFull={dsnFull}
      dsnMasked={dsnMasked}
    />
  );
}
