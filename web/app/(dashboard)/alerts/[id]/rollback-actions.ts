"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { rollbackAlertDeploy } from "@/lib/services/alert-rollback";

/**
 * Roll back the deployment associated with an alert to its last successful
 * production deploy. Host-agnostic — dispatches to whichever hosting
 * integration the project has connected (Vercel, Netlify, Cloudflare Pages,
 * Render) via the shared `rollbackAlertDeploy` service.
 */
export async function rollbackDeploy(
  alertId: string,
): Promise<{ url?: string; provider?: string; error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  const result = await rollbackAlertDeploy({
    alertId,
    userId,
    source: "dashboard",
  });

  if (result.error) return { error: result.error };

  revalidatePath(`/alerts/${alertId}`);
  revalidatePath("/alerts");

  return { url: result.url, provider: result.provider };
}

/**
 * Legacy alias — old UI code may still import `rollbackVercelDeploy`.
 * Delegates to the host-agnostic `rollbackDeploy`. Kept so existing clients
 * don't break while the transition completes.
 */
export const rollbackVercelDeploy = rollbackDeploy;
