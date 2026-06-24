/**
 * Inari Live Phase 5.3 — scoped memory.
 *
 * In-memory ring buffer (size 3) that the dock surface populates as
 * slash commands produce structured output. Powers two downstream
 * features:
 *
 *   1. **Autocomplete context** (Phase 5.4) — the last N command
 *      outputs get spliced into the `/api/ai/suggest-slash` system
 *      prompt so the LLM can resolve references like "esa alerta"
 *      into a concrete slash dispatch.
 *
 *   2. **Picker pre-fill** (Phase 5.5+) — when `/health` suspends
 *      asking for a project, the project picker pre-selects the
 *      most-recently-installed project from memory. When `/fix`
 *      suspends asking for an alert, the alert picker promotes the
 *      alerts mentioned in the last `/alerts` output.
 *
 * ## Scope
 *
 * Pure TS, no IPC, no persistence. The buffer lives in the
 * DockConversation's ref and clears on reload (per the plan: "in-session
 * only, no DB writes, no cross-session resolution").
 *
 * Architectural invariant: the resolver runs deterministically — no
 * LLM call. The LLM autocomplete uses scoped memory as RAW context;
 * it never queries the resolver. The resolver's narrow job is to
 * answer "what does 'esa alerta' refer to?" without needing the
 * cloud.
 */

// ── Entity types ──────────────────────────────────────────────────────────

/**
 * What kinds of entities scoped memory recognises. Mirrors
 * [`SlotKind`] from `suspended-command.ts` but adds a richer payload
 * per entity (severity, name) so the resolver can disambiguate and
 * the autocomplete-prompt formatter can produce useful context.
 */
export type ResolvedEntity =
  | { type: "alert"; id: string; hash: string | null; title: string; severity: string }
  | { type: "project"; id: string; name: string; slug?: string; localPath?: string }
  | { type: "contact"; jid: string; name: string }
  | { type: "path"; value: string };

export type EntityType = ResolvedEntity["type"];

/**
 * One slot in the ring buffer. Captures everything Phase 5.4's
 * autocomplete prompt + Phase 5.5+'s picker pre-fill needs:
 * - the command name (so "fixea esa" can be tied back to the prior
 *   `/alerts` call),
 * - the args that ran (for context — "/alerts 50" vs "/alerts"),
 * - a one-line summary suitable for the prompt + display,
 * - the list of entities the output produced.
 */
export interface MemoryEntry {
  /** Command name WITHOUT leading `/`, e.g. "alerts", "install". */
  commandName: string;
  /** Args the command ran with (typed values, not the raw string). */
  args: Record<string, unknown>;
  /** Rendered summary line, e.g. "5 critical alerts, top: TypeError…". */
  summary: string;
  /** Entities surfaced by the output — ordered by display order. */
  entities: ResolvedEntity[];
  /** Unix milliseconds. Used by the prompt formatter ("just now / 2m ago"). */
  timestamp: number;
}

// ── Bilingual reference detection ─────────────────────────────────────────

/**
 * Spanish + English type tokens. Keys are the lowercased match;
 * values are the canonical entity type. Plurals and minor inflections
 * are listed explicitly so the matcher stays a flat lookup — no
 * stemming.
 */
const TYPE_TOKENS: Record<string, EntityType> = {
  alert: "alert",
  alerts: "alert",
  alerta: "alert",
  alertas: "alert",
  incident: "alert",
  incidente: "alert",
  project: "project",
  projects: "project",
  proyecto: "project",
  proyectos: "project",
  repo: "project",
  repos: "project",
  contact: "contact",
  contacts: "contact",
  contacto: "contact",
  contactos: "contact",
  person: "contact",
  persona: "contact",
  path: "path",
  paths: "path",
  carpeta: "path",
  carpetas: "path",
  folder: "path",
  folders: "path",
  directory: "path",
  directorio: "path",
};

/**
 * Demonstratives + definite articles that signal "the prior one".
 * `that` / `ese` / `esa` / `aquel` / etc. — the user is referring
 * back to something already mentioned.
 */
const DEMONSTRATIVES = new Set([
  // Spanish
  "ese", "esa", "esos", "esas",
  "este", "esta", "estos", "estas",
  "aquel", "aquella", "aquellos", "aquellas",
  "el", "la", "los", "las",
  // English
  "that", "those", "this", "these", "the",
]);

/**
 * Ordinal tokens. Maps each spelling onto a positional index into the
 * most-recent entry's `entities` array.
 *
 *   "primer" / "primero" / "primera" / "first" → 0
 *   "segundo" / "segunda" / "second"           → 1
 *   "tercer" / "tercero" / "tercera" / "third" → 2
 *   "último" / "ultimo" / "última" / "ultima" / "last" → -1 (special)
 */
const ORDINAL_TOKENS: Record<string, number> = {
  primer: 0,
  primero: 0,
  primera: 0,
  first: 0,
  segundo: 1,
  segunda: 1,
  second: 1,
  tercer: 2,
  tercero: 2,
  tercera: 2,
  third: 2,
  cuarto: 3,
  cuarta: 3,
  fourth: 3,
  quinto: 4,
  quinta: 4,
  fifth: 4,
  sexto: 5,
  sexta: 5,
  sixth: 5,
  septimo: 6,
  septima: 6,
  "séptimo": 6,
  "séptima": 6,
  seventh: 6,
  octavo: 7,
  octava: 7,
  eighth: 7,
  noveno: 8,
  novena: 8,
  ninth: 8,
  decimo: 9,
  decima: 9,
  "décimo": 9,
  "décima": 9,
  tenth: 9,
  ultimo: -1,
  última: -1,
  ultima: -1,
  "último": -1,
  last: -1,
};

// ── Scoped memory ─────────────────────────────────────────────────────────

/**
 * Configuration knobs. Single struct so tests can override
 * `capacity` cleanly. Defaults match the Phase 5 plan: 3 entries.
 */
export interface ScopedMemoryConfig {
  capacity?: number;
  /**
   * Clock function — replaceable in tests so deterministic timestamps
   * land in the buffer without mocking globals. Defaults to `Date.now`.
   */
  now?: () => number;
}

const DEFAULT_CAPACITY = 3;

export class ScopedMemory {
  private buffer: MemoryEntry[] = [];
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(config: ScopedMemoryConfig = {}) {
    this.capacity = config.capacity ?? DEFAULT_CAPACITY;
    this.now = config.now ?? (() => Date.now());
  }

  /**
   * Append an entry. When at capacity, drops the oldest. The
   * timestamp is auto-stamped from the configured clock — callers
   * never set it manually so two entries pushed in the same tick
   * stay monotonically ordered.
   */
  push(entry: Omit<MemoryEntry, "timestamp">): void {
    this.buffer.push({ ...entry, timestamp: this.now() });
    while (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
  }

  /**
   * Return the most recent `n` entries, newest last. Default `n` is
   * the configured capacity (everything in the buffer). Returns a
   * fresh array so callers can iterate without mutating the buffer.
   */
  recent(n?: number): MemoryEntry[] {
    const take = n ?? this.capacity;
    return this.buffer.slice(-take);
  }

  /** Number of entries currently in the buffer. */
  size(): number {
    return this.buffer.length;
  }

  /** Drop every entry. Used by `/clear` to keep memory in sync. */
  reset(): void {
    this.buffer = [];
  }

  /**
   * Resolve a natural-language reference ("esa alerta", "el último
   * proyecto") to a concrete entity from the buffer. Deterministic —
   * NO LLM call. Returns `null` when:
   *   - The buffer is empty.
   *   - The text has no demonstrative/ordinal/type signal.
   *   - The signalled entity type has no rows in any recent entry.
   *
   * Resolution rules (in priority order):
   *
   *   1. **Reference + type**: "esa alerta" / "that project" →
   *      most recent entity of that type across the whole buffer.
   *   2. **Ordinal + type**: "el último proyecto" → ordinal index
   *      into the entities of the most-recent entry that has rows
   *      of that type. -1 means "last", positive indexes count from 0.
   *   3. **Ordinal alone**: "el primero" / "the last" → ordinal
   *      index into the most-recent entry's entities (any type).
   *   4. **Demonstrative alone**: "ese" / "that" → first entity of
   *      the most-recent entry. Equivalent to "el primero".
   *
   * Matching is case-insensitive and tolerant of leading/trailing
   * whitespace.
   */
  resolveReference(text: string): ResolvedEntity | null {
    if (this.buffer.length === 0) return null;

    const tokens = tokenize(text);
    if (tokens.length === 0) return null;

    const typeHint = findTypeHint(tokens);
    const ordinal = findOrdinal(tokens);
    const demonstrative = hasDemonstrative(tokens);

    if (!typeHint && ordinal === null && !demonstrative) return null;

    // Rule 1: type-aware lookup walks the buffer newest-first and
    // returns the most-recent entity matching the type. Honors
    // ordinals when present.
    if (typeHint !== null) {
      const ofType = collectByType(this.buffer, typeHint);
      if (ofType.length === 0) return null;
      if (ordinal !== null) {
        return atOrdinal(ofType, ordinal);
      }
      // Bare demonstrative + type → most recent.
      return ofType[ofType.length - 1] ?? null;
    }

    // Rule 3 / 4: no type hint — work off the most recent entry's
    // entity list. Ordinal indexes into it; demonstrative alone is
    // equivalent to ordinal=0.
    const lastEntry = this.buffer[this.buffer.length - 1]!;
    if (lastEntry.entities.length === 0) return null;
    if (ordinal !== null) {
      return atOrdinal(lastEntry.entities, ordinal);
    }
    return lastEntry.entities[0] ?? null;
  }

  /**
   * Render the buffer as a compact text block for the
   * `/api/ai/suggest-slash` system prompt. Each entry produces a
   * heading + the rendered summary + a flat list of `(type id title)`
   * tuples. Total length budgeted under ~500 tokens.
   *
   * Returns an empty string when the buffer is empty — the
   * autocomplete route detects that and skips the "Recent context"
   * section entirely, keeping the prompt minimal for fresh sessions.
   */
  toAutocompletePromptContext(): string {
    if (this.buffer.length === 0) return "";
    const now = this.now();
    const lines: string[] = ["Recent context (most recent last):"];
    for (const entry of this.buffer) {
      const age = formatAge(now - entry.timestamp);
      lines.push(`- /${entry.commandName} (${age}) — ${entry.summary}`);
      // Cap per-entry entity expansion so the prompt stays bounded.
      const cap = 8;
      const shown = entry.entities.slice(0, cap);
      for (const e of shown) {
        lines.push(`  • ${describeEntity(e)}`);
      }
      if (entry.entities.length > cap) {
        lines.push(`  • (+${entry.entities.length - cap} more)`);
      }
    }
    return lines.join("\n");
  }
}

// ── Pure helpers (exported for tests) ─────────────────────────────────────

/**
 * Lowercase + split on word boundaries. Stripping punctuation keeps
 * "esa, alerta" matching the same way as "esa alerta".
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFC")
    .split(/[\s,.!?¿¡;:()/]+/)
    .filter((t) => t.length > 0);
}

/** First token from `tokens` that maps to a known entity type. */
export function findTypeHint(tokens: string[]): EntityType | null {
  for (const t of tokens) {
    const hit = TYPE_TOKENS[t];
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * First ordinal token in the list, or null. Returns the position
 * value from `ORDINAL_TOKENS` (-1 for "last", non-negative for
 * positional indexes).
 */
export function findOrdinal(tokens: string[]): number | null {
  for (const t of tokens) {
    const value = ORDINAL_TOKENS[t];
    if (value !== undefined) return value;
  }
  return null;
}

export function hasDemonstrative(tokens: string[]): boolean {
  for (const t of tokens) {
    if (DEMONSTRATIVES.has(t)) return true;
  }
  return false;
}

/**
 * Collect entities of `type` across the buffer in OUTPUT order
 * (oldest first within each entry, oldest entry first overall). The
 * "most recent" entity is the last element of the result.
 */
export function collectByType(
  buffer: readonly MemoryEntry[],
  type: EntityType,
): ResolvedEntity[] {
  const out: ResolvedEntity[] = [];
  for (const entry of buffer) {
    for (const e of entry.entities) {
      if (e.type === type) out.push(e);
    }
  }
  return out;
}

/**
 * Index into `entities` honouring negative ordinals (`-1` = last).
 * Out-of-range indexes return null so the caller falls through.
 */
export function atOrdinal(
  entities: ResolvedEntity[],
  ordinal: number,
): ResolvedEntity | null {
  if (entities.length === 0) return null;
  if (ordinal < 0) {
    const idx = entities.length + ordinal;
    return idx >= 0 ? entities[idx] ?? null : null;
  }
  return entities[ordinal] ?? null;
}

/**
 * Render a one-line entity for the autocomplete prompt context.
 * Distinct per kind so the LLM has a uniform expected shape.
 */
export function describeEntity(e: ResolvedEntity): string {
  switch (e.type) {
    case "alert": {
      const hashPart = e.hash ? ` hash=${e.hash.slice(0, 8)}` : "";
      return `alert id=${e.id}${hashPart} severity=${e.severity} title="${truncate(e.title, 60)}"`;
    }
    case "project":
      return `project id=${e.id} name="${truncate(e.name, 40)}"${e.localPath ? ` path=${e.localPath}` : ""}`;
    case "contact":
      return `contact name="${truncate(e.name, 40)}" jid=${e.jid}`;
    case "path":
      return `path "${truncate(e.value, 80)}"`;
  }
}

/** Approximate "2m ago" / "just now" stamp. */
export function formatAge(deltaMs: number): string {
  if (deltaMs < 30_000) return "just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
