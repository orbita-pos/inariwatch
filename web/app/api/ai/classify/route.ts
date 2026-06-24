import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { callAI } from "@/lib/ai/client";
import { getPlatformTogetherKey, getPlatformOpenAIKey } from "@/lib/ai/get-key";
import { getTogetherOverride } from "@/lib/ai/together-routing";
import { authenticateExtensionToken } from "@/lib/auth-extension";
import { rateLimit } from "@/lib/auth-rate-limit";
import { getRedis } from "@/lib/redis";

// Zero-shot classification — intentionally lean prompt (~60 tokens output max).
const SYSTEM_PROMPT = `You are an intent classifier for an ops chat assistant. Given the user message, output ONLY valid JSON with two fields:
- "intent": one of [list_alerts, status_summary, uptime_monitors, recent_deploys, oncall_status, help, error_trends, root_cause, ack_alert, silence_alert] or null if none fits
- "confidence": float 0.0-1.0

Intent guide:
- error_trends: questions about error counts over time, trends, daily breakdown, top recurring errors
- root_cause: questions asking why something failed, what caused an error, AI diagnosis of an alert
- ack_alert: user acknowledges / marks as read the most recent alert ("ack", "got it", "ya lo vi", "enterado", "acknowledge")
- silence_alert: user wants to close / resolve / dismiss the most recent alert ("silence", "dismiss", "cerrar", "mark as resolved", "ya está arreglado")

Rules:
- Return null intent if the message is not covered by the ten intents above
- Do not add any text outside the JSON object`;

const VALID_INTENTS = new Set([
  "list_alerts",
  "status_summary",
  "uptime_monitors",
  "recent_deploys",
  "oncall_status",
  "help",
  "error_trends",
  "root_cause",
  "ack_alert",
  "silence_alert",
]);

const CACHE_TTL_SECONDS  = 300;            // 5 min — same text → same intent
const RATE_LIMIT_PER_MIN = 60;             // per user per minute
const MAX_TEXT_LENGTH    = 500;            // anti-abuse upper bound

export async function POST(req: NextRequest) {
  // ── Auth: V1 device-token (hot path) or pre-S1 api_keys fallback ──
  const auth = await authenticateExtensionToken(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Per-user rate limit (60/min) — Redis-backed via auth-rate-limit ──
  const rl = await rateLimit("ai.classify", auth.userId, {
    windowMs: 60_000,
    max: RATE_LIMIT_PER_MIN,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds ?? 60) } },
    );
  }

  // ── Parse body ──
  let text: string;
  try {
    const body = (await req.json()) as { text?: unknown };
    if (typeof body.text !== "string" || !body.text.trim()) {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
    }
    text = body.text.trim().slice(0, MAX_TEXT_LENGTH);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── Redis cache — sha256(text) → { intent, confidence } ──
  const redis = getRedis();
  const cacheKey = `ai:classify:${crypto.createHash("sha256").update(text).digest("hex")}`;
  if (redis) {
    try {
      const cached = await redis.get<{ intent: string | null; confidence: number }>(cacheKey);
      if (cached && (cached.intent === null || VALID_INTENTS.has(cached.intent))) {
        return NextResponse.json(cached);
      }
    } catch {
      /* cache miss path */
    }
  }

  // ── Resolve AI key — Together (Qwen flagship for analysis) → OpenAI fallback ──
  const togetherKey = getPlatformTogetherKey();
  const openaiKey   = getPlatformOpenAIKey();
  const keyResult   = togetherKey ?? openaiKey;
  if (!keyResult) {
    return NextResponse.json({ intent: null, confidence: 0 });
  }

  // Route platform-funded users to the Qwen3 analysis tier; BYOK / OpenAI
  // fallback uses whatever resolveModel picked. The override resolves null
  // when the flag is off or no Together key is set.
  const tAnalysis = getTogetherOverride("chat.conversational", true);
  const provider  = tAnalysis?.provider ?? keyResult.provider;
  const apiKey    = tAnalysis?.key      ?? keyResult.key;
  const model     = tAnalysis?.model;

  try {
    const raw = await callAI(
      apiKey,
      SYSTEM_PROMPT,
      [{ role: "user", content: text }],
      {
        maxTokens: 80,
        temperature: 0,
        provider,
        model,
        jsonMode: true,
        timeout: 15_000,
      },
    );

    const parsed = JSON.parse(raw) as { intent?: unknown; confidence?: unknown };
    const intent = typeof parsed.intent === "string" && VALID_INTENTS.has(parsed.intent)
      ? parsed.intent
      : null;
    const confidence = typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;

    const result = { intent, confidence };

    // Persist to cache. Errors are non-fatal — the response is already valid.
    if (redis) {
      void (async () => {
        try {
          await redis.set(cacheKey, result, { ex: CACHE_TTL_SECONDS });
        } catch {
          /* cache write failure ignored */
        }
      })();
    }

    return NextResponse.json(result);
  } catch {
    // Classification failure is non-fatal — caller falls back to LLM
    return NextResponse.json({ intent: null, confidence: 0 });
  }
}
