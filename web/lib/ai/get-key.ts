import { db, apiKeys, projects } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { detectProvider, type AIProvider } from "./client";
import { decrypt } from "@/lib/crypto";

/**
 * Fetch the user's AI key from the database.
 * Prefers Claude key; falls back to OpenAI.
 */
export async function getUserAIKey(userId: string): Promise<{
  key: string;
  provider: AIProvider;
} | null> {
  // Prefer Claude key
  const [claudeRow] = await db
    .select({ keyEncrypted: apiKeys.keyEncrypted })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.service, "claude")))
    .limit(1);

  if (claudeRow) {
    return { key: decrypt(claudeRow.keyEncrypted), provider: "claude" };
  }

  // Fall back to OpenAI
  const [openaiRow] = await db
    .select({ keyEncrypted: apiKeys.keyEncrypted })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.service, "openai")))
    .limit(1);

  if (openaiRow) {
    return { key: decrypt(openaiRow.keyEncrypted), provider: "openai" };
  }

  return null;
}

/**
 * Get project owner's AI key — used in background/cron tasks.
 */
export async function getProjectOwnerAIKey(projectId: string): Promise<{
  key: string;
  provider: AIProvider;
} | null> {
  const [project] = await db
    .select({ userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) return null;
  return getUserAIKey(project.userId);
}
