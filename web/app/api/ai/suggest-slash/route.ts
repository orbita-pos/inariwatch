// Inari Live pure-slash Phase 2 — natural-language → slash command translator.
//
// Single AI surface in the desktop chat input. The Tauri IPC
// `suggest_slash_commands` (in `desktop/src-tauri/src/ipc/slash.rs`) POSTs
// here with the user's typed query + the canonical SLASH_MANIFEST; this
// route returns up to 3 ranked slash-command suggestions for the
// autocomplete dropdown. The AI is a SCOUT, never an AGENT — it never
// executes anything, the user always confirms with Enter.
//
// Routing: `chat.suggest-command` task → ASSIST bucket → Qwen3.5-9B
// (platform-funded users). BYOK / non-routed cohorts fall back to OpenAI
// gpt-4o-mini via callAI's normal resolution.
//
// Cost target: ~$0.0001/call at the design ratio of 500 in / 50 out
// tokens. The manifest is the only large input — we cap it at 100 entries
// and ~20KB serialized.
//
// Pure helpers (validateBody, parseAndValidateOutput, etc.) live in
// `./helpers` because Next.js's route-file validation rejects arbitrary
// named exports from `route.ts`. Tests drive helpers directly.

import crypto from "crypto";

import { NextRequest, NextResponse } from "next/server";

import { callAI } from "@/lib/ai/client";
import { getPlatformOpenAIKey, getPlatformTogetherKey } from "@/lib/ai/get-key";
import { getTogetherOverride } from "@/lib/ai/together-routing";
import { authenticateExtensionToken } from "@/lib/auth-extension";
import { rateLimit } from "@/lib/auth-rate-limit";
import { getRedis } from "@/lib/redis";

import {
  CACHE_TTL_SECONDS,
  MAX_MANIFEST_BYTES,
  MAX_TOKENS_OUT,
  RATE_LIMIT_PER_MIN,
  REQUEST_TIMEOUT_MS,
  SYSTEM_PROMPT,
  buildUserPrompt,
  manifestRefValid,
  parseAndValidateOutput,
  serializeManifestCompact,
  validateBody,
  type SuggestSlashBody,
  type SuggestSlashResponse,
} from "./helpers";

// ── Handler ───────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth: V1 device-token (hot path) or pre-S1 api_keys fallback ──
  const auth = await authenticateExtensionToken(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Per-user rate limit (60/min) ──
  const rl = await rateLimit("ai.suggest-slash", auth.userId, {
    windowMs: 60_000,
    max: RATE_LIMIT_PER_MIN,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfterSeconds ?? 60) },
      },
    );
  }

  // ── Parse + validate body ──
  let parsed: SuggestSlashBody;
  try {
    const body = (await req.json()) as Partial<SuggestSlashBody>;
    const validated = validateBody(body);
    if (typeof validated === "string") {
      return NextResponse.json({ error: validated }, { status: 400 });
    }
    parsed = validated;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const manifestNames = new Set(parsed.manifest.map((e) => e.name));
  const compactManifestJson = serializeManifestCompact(parsed.manifest);
  if (compactManifestJson.length > MAX_MANIFEST_BYTES) {
    return NextResponse.json(
      { error: `manifest serializes to ${compactManifestJson.length} bytes; max ${MAX_MANIFEST_BYTES}` },
      { status: 400 },
    );
  }

  // ── Redis cache — sha256(query + manifest hash + memory hash) ──
  // Phase 5.4: memoryContext joins the cache key so two requests
  // with the SAME query+manifest but DIFFERENT memory don't collide
  // on a single cached suggestion list. Memory shifts intent
  // ("fixea la del payment" depends on what was just listed); cache
  // collisions on memory would surface a stale resolution.
  const redis = getRedis();
  const cacheKey = computeCacheKey(
    parsed.query,
    compactManifestJson,
    parsed.memoryContext,
  );
  if (redis) {
    try {
      const cached = await redis.get<SuggestSlashResponse>(cacheKey);
      if (cached && Array.isArray(cached.suggestions)) {
        // Re-validate against THIS manifest (cached suggestions may
        // reference commands that have since been removed). Filter
        // them out rather than skipping the cache outright so a
        // partial match still saves a round-trip.
        const filtered = cached.suggestions.filter((s) =>
          manifestRefValid(s.command, manifestNames),
        );
        return NextResponse.json({ suggestions: filtered });
      }
    } catch {
      /* cache miss — fall through */
    }
  }

  // ── Resolve AI key (Together preferred, OpenAI fallback) ──
  const togetherKey = getPlatformTogetherKey();
  const openaiKey   = getPlatformOpenAIKey();
  const keyResult   = togetherKey ?? openaiKey;
  if (!keyResult) {
    // No platform key — return an empty suggestion list so the
    // autocomplete falls through to "No command matches" gracefully.
    // (BYOK extension users currently land here too; future: read
    // from apiKeys for the user. For Inari Live the platform key is
    // always set in production.)
    return NextResponse.json({ suggestions: [] });
  }

  // Route platform-funded users to the ASSIST bucket (Qwen3.5-9B).
  // When the flag is off OR BYOK is in play, fall back to OpenAI on
  // gpt-4o-mini — same per-call cost ballpark, slightly higher
  // latency, but no behavior surprises.
  const override = getTogetherOverride("chat.suggest-command", true);
  const provider = override?.provider ?? keyResult.provider;
  const apiKey   = override?.key      ?? keyResult.key;
  const model    = override?.model    ?? undefined;

  // ── LLM call ──
  // Phase 5.4 placement: manifest (cacheable) → memoryContext
  // (variable, optional) → user query. Memory sits adjacent to the
  // query so it stays in the end-of-prompt attention window
  // without contaminating the cacheable prefix.
  const userPrompt = buildUserPrompt(
    compactManifestJson,
    parsed.query,
    parsed.memoryContext,
  );
  let raw: string;
  try {
    raw = await callAI(
      apiKey,
      SYSTEM_PROMPT,
      [{ role: "user", content: userPrompt }],
      {
        maxTokens: MAX_TOKENS_OUT,
        temperature: 0,
        provider,
        model,
        jsonMode: true,
        timeout: REQUEST_TIMEOUT_MS,
      },
    );
  } catch {
    // Provider failure — empty list (frontend shows "No command matches").
    return NextResponse.json({ suggestions: [] });
  }

  // ── Parse + validate output ──
  const suggestions = parseAndValidateOutput(raw, manifestNames);
  const result: SuggestSlashResponse = { suggestions };

  // Persist to cache (fire-and-forget — cache write failure must not
  // block the response).
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
}

// ── Internals (route-local — Next.js allows non-exported names) ──

/**
 * Cache key — sha256 over the user's lower-cased trimmed query, the
 * serialised manifest, AND (Phase 5.4) the scoped-memory context.
 * Two callers that send the same query against the same manifest AND
 * the same memory context hit the same cache entry; different memory
 * = distinct entries so a stale resolution doesn't surface.
 */
function computeCacheKey(
  query: string,
  manifestJson: string,
  memoryContext: string | undefined,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(query.trim().toLowerCase())
    .update("\0")
    .update(manifestJson)
    .update("\0")
    .update(memoryContext ?? "")
    .digest("hex");
  return `ai:suggest-slash:${digest}`;
}
