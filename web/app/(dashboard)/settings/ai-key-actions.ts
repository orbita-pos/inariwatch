"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, apiKeys, users } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { encrypt } from "@/lib/crypto";
import type { AIModelPreferences, AITask } from "@/lib/ai/models";
import { CLAUDE_MODELS, OPENAI_MODELS, GROK_MODELS, DEEPSEEK_MODELS, GEMINI_MODELS, DEFAULT_MODEL_PREFS } from "@/lib/ai/models";
import type { AIProvider } from "@/lib/ai/client";
import { validateProviderKey } from "@inariwatch/ai-router";

const ALL_MODEL_IDS = new Set([
  "auto",
  ...CLAUDE_MODELS.map((m) => m.id),
  ...OPENAI_MODELS.map((m) => m.id),
  ...GROK_MODELS.map((m) => m.id),
  ...DEEPSEEK_MODELS.map((m) => m.id),
  ...GEMINI_MODELS.map((m) => m.id),
]);

const AI_SERVICES = ["claude", "openai", "grok", "deepseek", "gemini"];

function resolveService(rawKey: string, providerHint?: string): AIProvider | null {
  if (rawKey.startsWith("sk-ant-"))  return "claude";
  if (rawKey.startsWith("xai-"))     return "grok";
  if (rawKey.startsWith("AIza"))     return "gemini";
  if (rawKey.startsWith("sk-")) {
    // sk- is ambiguous between OpenAI and DeepSeek — use hint
    if (providerHint === "deepseek") return "deepseek";
    return "openai";
  }
  return null;
}

async function validateKey(rawKey: string, provider: AIProvider): Promise<{ error?: string }> {
  // v0.3 S2.5: routed through @inariwatch/ai-router so the raw provider URL
  // lives inside `packages/ai-router/src/providers/` (lockdown rule allowed).
  const r = await validateProviderKey(provider, rawKey);
  if (!r.valid) return { error: r.error ?? "Invalid API key" };
  return {};
}

export async function saveAIKey(
  rawKey: string,
  providerHint?: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  const service = resolveService(rawKey, providerHint);
  if (!service) {
    return { error: "Unrecognized key format. Expected: sk-ant-… (Claude), sk-… (OpenAI/DeepSeek), xai-… (Grok), AIza… (Gemini)" };
  }

  const validationError = await validateKey(rawKey, service);
  if (validationError.error) return validationError;

  // Upsert — remove old key for this provider, insert new one
  await db.delete(apiKeys).where(and(eq(apiKeys.userId, userId), eq(apiKeys.service, service)));
  await db.insert(apiKeys).values({ userId, service, keyEncrypted: encrypt(rawKey) });

  revalidatePath("/settings");
  return {};
}

export async function deleteAIKey(): Promise<void> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return;

  await db.delete(apiKeys).where(
    and(eq(apiKeys.userId, userId), inArray(apiKeys.service, AI_SERVICES))
  );

  revalidatePath("/settings");
}

export async function setActiveAIProvider(provider: string): Promise<void> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId || !AI_SERVICES.includes(provider)) return;

  const [userRow] = await db.select({ aiModels: users.aiModels }).from(users).where(eq(users.id, userId)).limit(1);
  const current = (userRow?.aiModels ?? {}) as Record<string, string>;

  await db.update(users).set({ aiModels: { ...current, activeProvider: provider }, updatedAt: new Date() }).where(eq(users.id, userId));
  revalidatePath("/settings");
}

export async function deleteAIKeyByProvider(provider: string): Promise<void> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return;

  if (!AI_SERVICES.includes(provider)) return;

  await db.delete(apiKeys).where(
    and(eq(apiKeys.userId, userId), eq(apiKeys.service, provider))
  );

  revalidatePath("/settings");
}

export async function saveModelPreferences(
  prefs: AIModelPreferences
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  for (const task of Object.keys(DEFAULT_MODEL_PREFS) as AITask[]) {
    if (!ALL_MODEL_IDS.has(prefs[task] ?? "auto")) {
      return { error: `Invalid model for ${task}` };
    }
  }

  await db
    .update(users)
    .set({ aiModels: prefs, updatedAt: new Date() })
    .where(eq(users.id, userId));

  revalidatePath("/settings");
  return {};
}
