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

const AI_SERVICES: AIProvider[] = ["openai", "claude", "groq", "grok", "deepseek", "gemini"];
// Priority order: openai → claude → groq → grok → deepseek → gemini
// OpenAI is the default as of 2026-04 — GPT-4o-mini (analysis) and GPT-5.4 (remediation)
// are more cost-effective than Claude equivalents at equal quality per benchmarks.
// Users can override via activeProvider in their model preferences.
const PRIORITY: Record<AIProvider, number> = {
  openai: 0, claude: 1, groq: 2, grok: 3, deepseek: 4, gemini: 5, together: 6,
};

/** Platform-funded GPT-4o-mini key for free-tier analysis (auto-analyze + correlate). */
const PLATFORM_KEY = process.env.PLATFORM_AI_KEY ?? "";
export const PLATFORM_MODEL = "gpt-4o-mini";

/** Platform-funded Claude key for agentic exploration (Haiku) + fix generation (Sonnet). */
const PLATFORM_ANTHROPIC_KEY = process.env.PLATFORM_ANTHROPIC_KEY ?? "";

/**
 * Platform-funded Together AI key. Used by the Qwen-32B routing for
 * cost-optimized non-critical tasks (postmortem; explore phase later).
 * Read on every call so a kamal env push (no rebuild) flips the key.
 * Step 4-lite — only postmortem reads this today; step 5 will add
 * failover to OpenAI on Together 429/5xx.
 */

function getPlatformFallback(): AIKeyResult | null {
  if (!PLATFORM_KEY) return null;
  return { key: PLATFORM_KEY, provider: "openai", modelPrefs: null, isPlatformKey: true };
}

/**
 * Get the platform Together key for postmortem (step 4-lite) +
 * explore phase (later). Returns null when PLATFORM_TOGETHER_KEY is
 * not set — caller must fall back to the user's normal aiKey.
 *
 * Reads `process.env` on every call (do NOT cache in a module-level
 * const) so a kamal env push without rebuild flips the value.
 */
export function getPlatformTogetherKey(): AIKeyResult | null {
  // PLATFORM_TOGETHER_KEY = production platform key (kamal env push)
  // TOGETHER_API_KEY = BYOK fallback / local dev
  const key = process.env.PLATFORM_TOGETHER_KEY || process.env.TOGETHER_API_KEY || "";
  if (!key) return null;
  return { key, provider: "together", modelPrefs: null, isPlatformKey: true };
}

/**
 * Get the platform Anthropic key for remediation tasks.
 * Used when the user doesn't have their own Claude key — InariWatch absorbs the cost.
 * Returns null if PLATFORM_ANTHROPIC_KEY is not configured.
 */
export function getPlatformAnthropicKey(): AIKeyResult | null {
  if (!PLATFORM_ANTHROPIC_KEY) return null;
  return { key: PLATFORM_ANTHROPIC_KEY, provider: "claude", modelPrefs: null, isPlatformKey: true };
}

/**
 * Get the platform OpenAI key — the canonical web default for analysis,
 * remediation, and anything that doesn't explicitly demand a Claude-only
 * path. Mirrors `getPlatformAnthropicKey` for symmetry. Returns null if
 * PLATFORM_AI_KEY is not configured.
 */
export function getPlatformOpenAIKey(): AIKeyResult | null {
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
