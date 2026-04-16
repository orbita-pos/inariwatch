import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, aiUsageLogs } from "@/lib/db";
import { eq } from "drizzle-orm";
import { callAIWithUsage, type AIMessage, type AIProvider } from "@/lib/ai/client";
import { computeCost } from "@/lib/ai/pricing";
import { logAICall } from "@/lib/ai/lens";

const PLATFORM_KEY = process.env.PLATFORM_AI_KEY ?? "";
const VALID_PROVIDERS: AIProvider[] = ["claude", "openai", "grok", "deepseek", "gemini", "groq"];

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string })?.email;
  if (!email || email !== process.env.ADMIN_EMAIL) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!PLATFORM_KEY) {
    return NextResponse.json({ error: "PLATFORM_AI_KEY not configured" }, { status: 500 });
  }

  let body: { requestId?: string; provider?: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { requestId, provider, model } = body;
  if (!requestId || !provider || !model) {
    return NextResponse.json({ error: "Missing params (requestId, provider, model)" }, { status: 400 });
  }
  if (!VALID_PROVIDERS.includes(provider as AIProvider)) {
    return NextResponse.json({ error: `Invalid provider: ${provider}` }, { status: 400 });
  }

  const [original] = await db
    .select()
    .from(aiUsageLogs)
    .where(eq(aiUsageLogs.requestId, requestId))
    .limit(1);
  if (!original) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 });
  }
  if (!original.prompt) {
    return NextResponse.json({ error: "No prompt stored — cannot replay" }, { status: 400 });
  }

  // Parse the stored prompt text back into systemPrompt + messages.
  // Format: "[SYSTEM]\n...\n---\n[USER]\n...\n---\n[ASSISTANT]\n..."
  // Parser is defensive: non-matching parts are skipped, so a stray `\n---\n`
  // in user content doesn't crash the split — it just becomes noise that the
  // parser ignores.
  const parts = original.prompt.split("\n---\n");
  let systemPrompt = "";
  const messages: AIMessage[] = [];
  for (const part of parts) {
    const match = part.match(/^\[(SYSTEM|USER|ASSISTANT)\]\n([\s\S]*)$/);
    if (!match) continue;
    const [, role, content] = match;
    if (role === "SYSTEM") systemPrompt = content;
    else messages.push({ role: role.toLowerCase() as "user" | "assistant", content });
  }

  if (messages.length === 0) {
    return NextResponse.json(
      { error: "Stored prompt has no user/assistant messages to replay" },
      { status: 400 }
    );
  }

  const started = Date.now();
  try {
    const result = await callAIWithUsage(PLATFORM_KEY, systemPrompt, messages, {
      model,
      provider: provider as AIProvider,
    });
    const durationMs = Date.now() - started;
    const costUsd = computeCost(
      result.model,
      result.usage.inputTokens,
      result.usage.outputTokens,
      result.usage.cachedInputTokens
    );

    // Log the replay as a new row so it shows up in the list and links back
    // to the original via replayOfRequestId.
    logAICall({
      userId: original.userId,
      projectId: original.projectId,
      alertId: original.alertId,
      remediationSessionId: original.remediationSessionId,
      feature: "replay",
      provider: result.provider,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      durationMs,
      isPlatformKey: true,
      cached: false,
      prompt: original.prompt,
      response: result.text,
      replayOfRequestId: requestId,
    });

    return NextResponse.json({
      text: result.text,
      durationMs,
      costUsd,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Replay failed" },
      { status: 500 }
    );
  }
}
