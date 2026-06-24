"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { encryptConfig, decryptConfig } from "@/lib/crypto";
import { revalidatePath } from "next/cache";

type EnvVarEntry = { key: string; value: string };

/** Save staging env vars (encrypts all values). */
export async function saveStagingEnvVars(
  projectId: string,
  vars: EnvVarEntry[]
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) return { error: "Project not found" };

  // Validate: no empty keys, no duplicates
  const keys = new Set<string>();
  for (const v of vars) {
    const k = v.key.trim();
    if (!k) return { error: "Empty variable name" };
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(k)) return { error: `Invalid variable name: ${k}` };
    if (keys.has(k)) return { error: `Duplicate variable: ${k}` };
    keys.add(k);
  }

  // Build plain object, then encrypt the whole thing
  const plain: Record<string, string> = {};
  for (const v of vars) {
    plain[v.key.trim()] = v.value;
  }

  await db
    .update(projects)
    .set({ stagingEnvEncrypted: encryptConfig(plain) })
    .where(eq(projects.id, projectId));

  revalidatePath(`/projects`);
  return {};
}

/** Get staging env var keys (values are masked). */
export async function getStagingEnvKeys(
  projectId: string
): Promise<{ keys: string[]; error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { keys: [], error: "Not authenticated" };

  const [project] = await db
    .select({ id: projects.id, stagingEnvEncrypted: projects.stagingEnvEncrypted })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) return { keys: [], error: "Project not found" };

  if (!project.stagingEnvEncrypted) return { keys: [] };

  const decrypted = decryptConfig(project.stagingEnvEncrypted);
  return { keys: Object.keys(decrypted) };
}

/** Read decrypted staging env vars (server-only, for staging deploy). */
export async function getDecryptedStagingEnvVars(
  projectId: string
): Promise<Record<string, string>> {
  const [project] = await db
    .select({ stagingEnvEncrypted: projects.stagingEnvEncrypted })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project?.stagingEnvEncrypted) return {};
  return decryptConfig(project.stagingEnvEncrypted) as Record<string, string>;
}
