// GitHub App webhook receiver.
//
// Events we subscribe to:
//   - installation: created / deleted / suspend / unsuspend
//   - installation_repositories: added / removed
//   - pull_request: optional, used later for setup-PR follow-ups
//
// Header: X-Hub-Signature-256 = sha256=<hmac>. Secret comes from
// GITHUB_APP_WEBHOOK_SECRET. Signature verified before parsing — we
// throw 401 on missing/wrong sigs without giving back any error detail.
//
// All handlers are idempotent. Failures return 5xx to trigger retry.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, githubAppInstallations } from "@/lib/db";
import { verifyWebhookSignature } from "@/lib/github-app/octokit";

interface InstallationEvent {
  action:       "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted";
  installation: { id: number; account: { login: string; type: string; id: number } };
}

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  if (!verifyWebhookSignature(raw, sig)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  switch (event) {
    case "installation":
      await onInstallation(payload as InstallationEvent);
      break;
    case "installation_repositories":
      // Repo set changed inside an existing installation. For the MVP
      // we don't auto-PR new repos — the user can re-trigger from the
      // dashboard. Ack so GitHub doesn't retry.
      break;
    case "pull_request":
      // Reserved for follow-ups (close stale setup PRs on uninstall).
      break;
    default:
      break;
  }

  return NextResponse.json({ ok: true });
}

async function onInstallation(ev: InstallationEvent): Promise<void> {
  const id = ev.installation.id;
  if (ev.action === "deleted" || ev.action === "suspend") {
    await db
      .update(githubAppInstallations)
      .set({ uninstalledAt: new Date(), updatedAt: new Date() })
      .where(eq(githubAppInstallations.installationId, id));
    return;
  }
  if (ev.action === "unsuspend") {
    await db
      .update(githubAppInstallations)
      .set({ uninstalledAt: null, updatedAt: new Date() })
      .where(eq(githubAppInstallations.installationId, id));
    return;
  }
  // `created` is handled in /api/integrations/github-app/setup which
  // runs in the user's session context — webhook fires too but we
  // already have the row.
}
