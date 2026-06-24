// Inari Live pure-slash Phase 2 — pure helpers for the
// `/api/ai/suggest-slash` route.
//
// Next.js's strict route-file validation rejects arbitrary named
// exports from `route.ts` — only the HTTP method handlers plus a
// closed set of config fields are allowed. The route's pure helpers
// (`validateBody`, `parseAndValidateOutput`) live here so the test
// suite can drive them directly without going through `POST`.

// ── Wire types (shared with route.ts) ─────────────────────────────────────

export interface ManifestArg {
  name: string;
  type: "string" | "number" | "enum" | "path";
  required: boolean;
  description: string;
  enumValues?: string[];
  flag?: string;
}

export interface ManifestEntry {
  name: string;
  description: string;
  args: ManifestArg[];
}

export interface SuggestSlashBody {
  query: string;
  manifest: ManifestEntry[];
  /**
   * Phase 5.4 — formatted scoped-memory context. Produced by the
   * desktop's `ScopedMemory.toAutocompletePromptContext()` (last 3
   * outputs with inline entity IDs + discriminators). Optional;
   * absent on first turn or after `/clear`.
   *
   * Validation caps the length at `MAX_MEMORY_CONTEXT_BYTES` so a
   * runaway buffer can't bloat the user prompt. The cacheable
   * prefix (role + manifest) is built BEFORE this field is read so
   * a future prompt-caching directive on the manifest section
   * stays valid even as memoryContext varies per request.
   */
  memoryContext?: string;
}

export interface SlashSuggestion {
  /** Full command line, e.g. "/projects --integration=capture". Always starts with `/`. */
  command: string;
  /** 1-line natural-language rationale for the autocomplete tooltip. */
  rationale: string;
  /** 0..1 confidence. Frontend uses this only to rank — no hard threshold here. */
  confidence: number;
}

export interface SuggestSlashResponse {
  suggestions: SlashSuggestion[];
}

// ── Bounds ────────────────────────────────────────────────────────────────

export const MAX_QUERY_LENGTH    = 200;       // human-typed natural-language input
export const MAX_MANIFEST_ENTRIES = 100;      // we ship ~40 today, headroom for growth
export const MAX_MANIFEST_BYTES   = 20_000;   // ≈ 5K tokens at compact JSON — plenty
export const MAX_SUGGESTIONS      = 3;        // top-N rank, per the plan
export const MAX_RATIONALE_LENGTH = 200;      // 1-line tooltip — anything longer is noise
export const CACHE_TTL_SECONDS    = 300;      // 5 min — same query+manifest → same suggestions
export const RATE_LIMIT_PER_MIN   = 60;       // per user per minute (matches /api/ai/classify)
export const MAX_TOKENS_OUT       = 200;      // 3 × ~50 tokens — caps cost
// Phase 5.4 — scoped-memory cap. 3 entries × (~120-byte summary +
// ~8 inline entities × ~120 bytes each) → ~3.2 KB worst case.
// Bump to 4 KB to leave headroom for prose framing without letting
// a runaway buffer dominate the user prompt.
export const MAX_MEMORY_CONTEXT_BYTES = 4_000;
export const REQUEST_TIMEOUT_MS   = 10_000;   // single-shot — fail fast

// ── Prompt (compact, kept under 300 tokens) ───────────────────────────────

export const SYSTEM_PROMPT = `You translate natural-language queries about InariWatch into specific slash commands. Given a user query and a list of available commands (with their args), return the top 3 commands that match the user's intent, ranked by confidence.

Each suggestion must be a valid command from the manifest with concrete args filled in (use the user's query to infer args). Never invent commands that aren't in the manifest. Never invent arg names that aren't declared.

Flag args render as \`--<flag>=<value>\` and go after the command name. Positional args go in declared order. Enum args must use one of the declared values.

If no command matches the user's query (e.g. they asked something off-topic), return an empty suggestions array. Off-topic includes: general programming questions, code explanation, debugging help unrelated to the user's projects/alerts, casual chat.

Output JSON only: {"suggestions": [{"command": "...", "rationale": "...", "confidence": 0.0-1.0}, ...]}`;

// ── Pure helpers ──────────────────────────────────────────────────────────

/**
 * Body validation. Returns the typed body on success, or a 1-line
 * error string for the 400 response on failure. Centralised so the
 * route handler's hot path stays linear.
 */
export function validateBody(
  body: Partial<SuggestSlashBody>,
): SuggestSlashBody | string {
  if (!body || typeof body !== "object") return "body must be an object";
  if (typeof body.query !== "string") return "query must be a string";
  const query = body.query.trim();
  if (!query) return "query is empty";
  if (query.length > MAX_QUERY_LENGTH) {
    return `query is ${query.length} chars; max ${MAX_QUERY_LENGTH}`;
  }
  if (!Array.isArray(body.manifest)) return "manifest must be an array";
  if (body.manifest.length === 0) return "manifest is empty";
  if (body.manifest.length > MAX_MANIFEST_ENTRIES) {
    return `manifest has ${body.manifest.length} entries; max ${MAX_MANIFEST_ENTRIES}`;
  }
  for (const entry of body.manifest) {
    if (!entry || typeof entry !== "object") return "manifest entries must be objects";
    if (typeof entry.name !== "string" || !entry.name.startsWith("/")) {
      return "every manifest entry.name must be a string starting with '/'";
    }
    if (typeof entry.description !== "string") {
      return "every manifest entry.description must be a string";
    }
    if (!Array.isArray(entry.args)) {
      return "every manifest entry.args must be an array";
    }
  }

  // Phase 5.4 — memoryContext is optional. When present, it must be
  // a string (frontend sends formatted text, not structured data) and
  // capped at MAX_MEMORY_CONTEXT_BYTES. Empty strings collapse to
  // undefined so the user-prompt builder cleanly skips the section.
  let memoryContext: string | undefined;
  if (body.memoryContext !== undefined && body.memoryContext !== null) {
    if (typeof body.memoryContext !== "string") {
      return "memoryContext must be a string when provided";
    }
    const trimmed = body.memoryContext.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > MAX_MEMORY_CONTEXT_BYTES) {
        return `memoryContext is ${trimmed.length} chars; max ${MAX_MEMORY_CONTEXT_BYTES}`;
      }
      memoryContext = trimmed;
    }
  }

  return { query, manifest: body.manifest, memoryContext };
}

/**
 * Compact serialiser — drops `examples` + `tone` (UI-only fields) plus
 * `enumValues` longer than the cap, so the user prompt stays tight.
 * The desktop's `serializeManifestForPrompt` already does the first
 * pass; we trust the caller and only re-encode for the cache hash +
 * size guard.
 */
export function serializeManifestCompact(manifest: ManifestEntry[]): string {
  const compact = manifest.map((entry) => ({
    name: entry.name,
    description: entry.description,
    args: entry.args.map((arg) => ({
      name: arg.name,
      type: arg.type,
      required: arg.required,
      description: arg.description,
      ...(arg.enumValues ? { enumValues: arg.enumValues } : {}),
      ...(arg.flag ? { flag: arg.flag } : {}),
    })),
  }));
  return JSON.stringify(compact);
}

/**
 * Extract `/<command>` from a suggestion's `command` field and check
 * it appears in the manifest. Lets us strip out hallucinated commands
 * (the LLM occasionally invents `/foo` despite the explicit "never
 * invent" rule).
 */
export function manifestRefValid(command: string, names: Set<string>): boolean {
  const space = command.indexOf(" ");
  const head = space < 0 ? command : command.slice(0, space);
  return names.has(head);
}

/**
 * Compose the user message. Phase 5.4 placement (research mini-diff,
 * Lost-in-the-Middle + Anthropic effective-context-engineering):
 *
 *   1. Manifest (large, stable, the cacheable region) — first.
 *   2. memoryContext (variable, fresh per request) — second, gated.
 *   3. User query — last.
 *
 * Why this order: the model's attention is highest at the start
 * (manifest, stable across requests) and at the end (query, the
 * actionable signal). Memory sits adjacent to the query so it stays
 * inside the end-of-prompt focus window without contaminating the
 * cacheable prefix that begins the message.
 *
 * Cacheable prefix invariant: the bytes returned by
 * `buildCacheableUserPromptPrefix(manifest)` are byte-identical
 * across two consecutive calls with the same manifest but different
 * memoryContext. The Phase 5.9 corpus locks this invariant so a
 * future edit can't accidentally splice memory into the cacheable
 * region.
 */
export function buildUserPrompt(
  manifestJson: string,
  query: string,
  memoryContext?: string,
): string {
  const prefix = buildCacheableUserPromptPrefix(manifestJson);
  const memoryBlock = memoryContext && memoryContext.length > 0
    ? `\n\n${memoryContext}`
    : "";
  return `${prefix}${memoryBlock}\n\nUser query:\n${query}`;
}

/**
 * Just the cacheable prefix of the user prompt: the manifest. Memory
 * + query are appended elsewhere. Exported so the Phase 5.9
 * regression test can assert byte-identical output across requests
 * with different memoryContext values.
 */
export function buildCacheableUserPromptPrefix(manifestJson: string): string {
  return `Available slash commands (JSON):\n${manifestJson}`;
}

/**
 * Parse the LLM's JSON output + filter to valid manifest references.
 * Always returns an array (empty on any failure) — the frontend uses
 * empty as the "no command matches" signal.
 */
export function parseAndValidateOutput(
  raw: string,
  manifestNames: Set<string>,
): SlashSuggestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.suggestions)) return [];

  const out: SlashSuggestion[] = [];
  for (const item of obj.suggestions) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (typeof s.command !== "string") continue;
    if (typeof s.rationale !== "string") continue;
    if (typeof s.confidence !== "number" || !Number.isFinite(s.confidence)) continue;
    const command = s.command.trim();
    if (!command.startsWith("/")) continue;
    if (!manifestRefValid(command, manifestNames)) continue;
    out.push({
      command,
      rationale: s.rationale.trim().slice(0, MAX_RATIONALE_LENGTH),
      confidence: Math.max(0, Math.min(1, s.confidence)),
    });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}
