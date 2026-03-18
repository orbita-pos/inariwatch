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
  try {
    switch (provider) {
      case "claude": {
        const res = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": rawKey, "anthropic-version": "2023-06-01" },
        });
        if (res.status === 401) return { error: "Invalid Claude API key." };
        break;
      }
      case "grok": {
        const res = await fetch("https://api.x.ai/v1/models", {
          headers: { Authorization: `Bearer ${rawKey}` },
        });
        if (res.status === 401) return { error: "Invalid Grok (xAI) API key." };
        break;
      }
      case "deepseek": {
        const res = await fetch("https://api.deepseek.com/v1/models", {
          headers: { Authorization: `Bearer ${rawKey}` },
        });
        if (res.status === 401) return { error: "Invalid DeepSeek API key." };
        break;
      }
      case "gemini": {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${rawKey}`
        );
        if (res.status === 400 || res.status === 403) return { error: "Invalid Gemini API key." };
        break;
      }
      default: {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${rawKey}` },
        });
        if (res.status === 401) return { error: "Invalid OpenAI API key." };
      }
    }
  } catch {
    return { error: "Could not validate key — check your connection and try again." };
  }
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
