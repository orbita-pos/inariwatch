import { db, apiKeys, projects, users } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import type { AIProvider } from "./client";
import { decrypt } from "@/lib/crypto";
import type { AIModelPreferences } from "./models";

export interface AIKeyResult {
  key: string;
  provider: AIProvider;
  modelPrefs: AIModelPreferences | null;
  /** True when using the platform key (free tier, limited to basic analysis). */
  isPlatformKey?: boolean;
}

const AI_SERVICES: AIProvider[] = ["claude", "openai", "grok", "deepseek", "gemini"];
// Priority order: claude → openai → grok → deepseek → gemini
const PRIORITY: Record<AIProvider, number> = {
  claude: 0, openai: 1, grok: 2, deepseek: 3, gemini: 4,
};

/** Platform-funded GPT-4o-mini key for free-tier analysis (auto-analyze + correlate). */
const PLATFORM_KEY = process.env.PLATFORM_AI_KEY ?? "";
export const PLATFORM_MODEL = "gpt-4o-mini";

function getPlatformFallback(): AIKeyResult | null {
  if (!PLATFORM_KEY) return null;
  return { key: PLATFORM_KEY, provider: "openai", modelPrefs: null, isPlatformKey: true };
}

/**
 * Fetch the user's AI key + model preferences from the database.
 * Uses first available key in priority order: claude → openai → grok → deepseek → gemini.
 */
export async function getUserAIKey(userId: string): Promise<AIKeyResult | null> {
  const [rows, [userRow]] = await Promise.all([
    db.select({ keyEncrypted: apiKeys.keyEncrypted, service: apiKeys.service })
      .from(apiKeys)
      .where(and(
        eq(apiKeys.userId, userId),
        inArray(apiKeys.service, AI_SERVICES as string[])
      )),
    db.select({ aiModels: users.aiModels })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  ]);

  if (rows.length === 0) return getPlatformFallback();

  const modelPrefs = (userRow?.aiModels as AIModelPreferences | null) ?? null;
  const activeProvider = modelPrefs?.activeProvider;

  // Use user's preferred provider if they have a key for it, else fall back to priority order
  const sorted = rows.sort(
    (a, b) => (PRIORITY[a.service as AIProvider] ?? 99) - (PRIORITY[b.service as AIProvider] ?? 99)
  );
  const preferred = activeProvider ? rows.find((r) => r.service === activeProvider) : undefined;
  const best = preferred ?? sorted[0];

  return {
    key: decrypt(best.keyEncrypted),
    provider: best.service as AIProvider,
    modelPrefs,
  };
}

/**
 * Get project owner's AI key — used in background/cron tasks.
 */
export async function getProjectOwnerAIKey(projectId: string): Promise<AIKeyResult | null> {
  const [project] = await db
    .select({ userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) return null;
  return getUserAIKey(project.userId);
}
