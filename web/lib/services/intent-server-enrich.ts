/**
 * Server-side intent enrichment (SKYNET §3 piece 20).
 *
 * The SDK-side intent compiler (`capture/src/intent/`) attaches an
 * `expected.contracts[]` shape to v2 payloads when it can read the
 * project's source from disk. That works for Node servers; it does NOT
 * work for browser bundles, edge runtimes without filesystem access,
 * or production builds where source files aren't shipped.
 *
 * This module fills that gap: when a v2 payload lands without
 * `expected.contracts`, we fetch the failing file from the project's
 * linked GitHub repo at the commit SHA the SDK reported, run a
 * lightweight TS extractor on it, and attach the resulting shape before
 * the alert is created.
 *
 * Design choices:
 *   - **Best-effort.** Every failure path returns `undefined` and the
 *     event proceeds unenriched. Webhook ingestion latency is sacred.
 *   - **GitHub immutability.** A file at a given commit SHA is
 *     immutable, so we cache the extraction result with a 7-day TTL
 *     (long enough to survive most retry storms; short enough to drop
 *     after a project deletes their repo).
 *   - **Pure regex extractor.** Server-side runs without the
 *     `typescript` peer that the SDK uses, both to keep the bundle
 *     small and to avoid a second source of truth that could drift
 *     from the SDK. The regex extractor handles the common ~80%
 *     (exported `interface`, `type` alias to object literal, basic
 *     `z.object({...})`); deeper cases stay with the SDK.
 *   - **Bounded.** GitHub API call is gated by a single `getFileContent`
 *     fetch with retry already built in. We don't recurse into
 *     `import`s — only the file the failing frame points at.
 */

import { db } from "@/lib/db";
import { projectIntegrations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { decryptConfig } from "@/lib/crypto";
import { getFileContent } from "@/lib/services/github-api";
import { getRedis } from "@/lib/redis";
import crypto from "crypto";

/** Wire shape — mirrors `IntentShape` from `capture/src/intent/types.ts`. */
export interface IntentShape {
  type?: "object" | "array" | "string" | "number" | "boolean" | "null" | "any" | "unknown";
  properties?: Record<string, IntentShape>;
  required?: string[];
  items?: IntentShape;
  enum?: unknown[];
  description?: string;
  $ref?: string;
  format?: string;
  _symbol?: string;
  _truncated?: true;
}

export interface IntentContract {
  source: "ts" | "zod";
  path: string;
  shape: IntentShape;
}

/** 10 KB serialized cap — same as the SDK. */
const MAX_SHAPE_BYTES = 10 * 1024;
/** 64 KB max source file we'll fetch — anything larger is almost certainly
 *  generated/vendored and the regex extractor would waste budget on it. */
const MAX_FILE_BYTES = 64 * 1024;
/** Redis cache TTL — git history at a SHA is immutable, but we let it
 *  expire so deleted repos stop using cache space. */
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Top-level entry point. Mutates `event.expected` in place when it can.
 *  Always resolves; never throws. */
export async function enrichEventIntentIfMissing(
  event: Record<string, unknown>,
  projectId: string,
): Promise<void> {
  // Only enrich v2 payloads — v1 doesn't carry stack frames in a stable
  // shape and predates the intent compiler entirely.
  if (event.schema_version !== "2.0") return;

  // Already enriched (by SDK or earlier server-side pass) — leave it alone.
  if (hasContracts(event.expected)) return;

  const top = topFrameFromEvent(event);
  if (!top) return;

  // Need a commit SHA. We could fall back to the project's default
  // branch HEAD, but that risks reading a different file than the one
  // that actually threw — refuse to enrich without an explicit SHA.
  const sha = readCommitSha(event);
  if (!sha) return;

  const repo = readRepoFromEvent(event);
  if (!repo) return;

  const cacheKey = computeCacheKey(repo.full, sha, top.file, top.function ?? null);
  const cached = await readFromCache(cacheKey);
  if (cached) {
    attach(event, cached, top.file);
    return;
  }
  if (cached === false) {
    // Negative cache hit — known to have no shape. Skip the GitHub call.
    return;
  }

  const gh = await loadGithubCreds(projectId);
  if (!gh) return;

  const repoPath = stripRepoPrefix(top.file, gh.owner, repo.name);
  if (!repoPath) return;

  let source: string | null;
  try {
    source = await getFileContent(gh.token, gh.owner, repo.name, repoPath, sha);
  } catch {
    return;
  }
  if (source == null) {
    await writeNegativeCache(cacheKey);
    return;
  }
  if (source.length > MAX_FILE_BYTES) {
    await writeNegativeCache(cacheKey);
    return;
  }

  const shape = extractShape(source, top.function ?? null);
  if (!shape) {
    await writeNegativeCache(cacheKey);
    return;
  }
  const contract: IntentContract = {
    source: shape._source,
    path: `${repo.full}@${sha.slice(0, 7)}:${repoPath}#${top.function ?? "?"}`,
    shape: capShapeSize(shape.shape),
  };
  await writePositiveCache(cacheKey, contract);
  attach(event, contract, top.file);
}

// ─── Stack frame + repo extraction ────────────────────────────────────────

function hasContracts(expected: unknown): boolean {
  if (!expected || typeof expected !== "object") return false;
  const e = expected as { contracts?: unknown };
  return Array.isArray(e.contracts) && e.contracts.length > 0;
}

interface TopFrame {
  file: string;
  line?: number;
  function?: string;
}

function topFrameFromEvent(event: Record<string, unknown>): TopFrame | null {
  // v2 payloads expose `evidence.stack` as an array of parsed frames.
  const evidence = event.evidence as { stack?: unknown[] } | undefined;
  if (evidence && Array.isArray(evidence.stack) && evidence.stack.length > 0) {
    const f = evidence.stack[0] as Record<string, unknown>;
    if (typeof f.file === "string" && f.file !== "<unknown>") {
      return {
        file: f.file,
        line: typeof f.line === "number" ? f.line : undefined,
        function: typeof f.function === "string" ? f.function : undefined,
      };
    }
  }
  // Fallback: parse the body the same way `parseStackForEvidence` does.
  const body = typeof event.body === "string" ? event.body : "";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const v8 = /^at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (v8) {
      const file = v8[2];
      if (file && file !== "<unknown>") {
        return {
          file,
          line: parseInt(v8[3] ?? "0", 10),
          function: v8[1] && v8[1] !== "<anonymous>" ? v8[1] : undefined,
        };
      }
    }
  }
  return null;
}

function readCommitSha(event: Record<string, unknown>): string | null {
  const git = event.git as { commit?: unknown } | undefined;
  const commit = git?.commit;
  if (typeof commit !== "string" || commit.length < 7) return null;
  // Accept both full and short SHAs; GitHub's contents API takes either.
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return null;
  return commit;
}

function readRepoFromEvent(event: Record<string, unknown>): { full: string; name: string } | null {
  const git = event.git as { repo?: unknown; url?: unknown } | undefined;
  if (!git) return null;

  // Direct `owner/repo`.
  if (typeof git.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(git.repo)) {
    const [, name] = git.repo.split("/");
    return { full: git.repo, name };
  }
  // Parse from `git.url` (e.g. `git@github.com:owner/repo.git`,
  // `https://github.com/owner/repo`, …).
  if (typeof git.url === "string") {
    const m =
      /github\.com[:\/]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[\/?#]|$)/i.exec(git.url);
    if (m) return { full: `${m[1]}/${m[2]}`, name: m[2] };
  }
  return null;
}

/** GitHub paths are repo-relative. Stack frames are usually absolute or
 *  build-tool-relative. Strip everything up to and including the first
 *  occurrence of the repo name. Returns `null` when we can't reliably
 *  rewrite the path (we'd rather skip than fetch the wrong file). */
export function stripRepoPrefix(filePath: string, _owner: string, repoName: string): string | null {
  // Already repo-relative (no leading slash, no drive letter, no
  // `node_modules/` prefix) — accept as-is.
  if (
    !/^[a-zA-Z]:[\\/]/.test(filePath) && // not Windows drive
    !filePath.startsWith("/") &&
    !filePath.startsWith("\\") &&
    !filePath.includes("node_modules/")
  ) {
    return filePath.replace(/\\/g, "/");
  }
  // Find `/<repoName>/` in the path and take the suffix.
  const norm = filePath.replace(/\\/g, "/");
  const marker = `/${repoName}/`;
  const idx = norm.indexOf(marker);
  if (idx >= 0) return norm.slice(idx + marker.length);
  return null;
}

// ─── Credential lookup ────────────────────────────────────────────────────

async function loadGithubCreds(projectId: string): Promise<{ token: string; owner: string } | null> {
  try {
    const integs = await db
      .select()
      .from(projectIntegrations)
      .where(eq(projectIntegrations.projectId, projectId));
    const gh = integs.find((i) => i.service === "github");
    if (!gh) return null;
    const config = decryptConfig(gh.configEncrypted) as { token?: unknown; owner?: unknown };
    if (typeof config.token !== "string" || typeof config.owner !== "string") return null;
    return { token: config.token, owner: config.owner };
  } catch {
    return null;
  }
}

// ─── Cache ────────────────────────────────────────────────────────────────

function computeCacheKey(repo: string, sha: string, path: string, symbol: string | null): string {
  // Hash the (potentially long) path + symbol to keep the key bounded.
  const h = crypto.createHash("sha256").update(`${path}\x00${symbol ?? ""}`).digest("hex").slice(0, 16);
  return `intent_enrich:${repo}:${sha.slice(0, 12)}:${h}`;
}

/** Returns:
 *    - a contract on cache hit
 *    - `false` on negative cache hit (known no shape)
 *    - `null` on miss
 */
async function readFromCache(key: string): Promise<IntentContract | false | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const v = await r.get<unknown>(key);
    if (v == null) return null;
    if (v === "NONE") return false;
    if (typeof v === "object" && v !== null && "shape" in v) return v as IntentContract;
  } catch {
    // Redis unavailable — proceed without cache.
  }
  return null;
}

async function writePositiveCache(key: string, contract: IntentContract): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try { await r.set(key, contract, { ex: CACHE_TTL_SECONDS }); } catch { /* best-effort */ }
}

async function writeNegativeCache(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  // Negative TTL is shorter — files come and go more readily than they
  // become parseable. Half a day is enough to absorb retry storms.
  try { await r.set(key, "NONE", { ex: 12 * 60 * 60 }); } catch { /* best-effort */ }
}

// ─── TS / Zod regex extractor ────────────────────────────────────────────

/** Result of {@link extractShape}: the shape plus the source dialect tag. */
interface ExtractedShape {
  shape: IntentShape;
  _source: "ts" | "zod";
}

/**
 * Look for a TypeScript interface, type alias, or zod schema named
 * `symbol` (or, when `symbol` is null, the first exported one). Pure
 * regex — kept deliberately conservative. The SDK-side compiler is the
 * canonical extractor; this is an 80%-coverage fallback for browser /
 * edge bundles where the SDK can't reach disk.
 */
export function extractShape(source: string, symbol: string | null): ExtractedShape | null {
  // Strip block + line comments to keep regexes simple. Doesn't handle
  // strings containing `/*` — uncommon and would only over-strip.
  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  // 1. `interface Foo { ... }` (with optional `extends`).
  const ifaceShape = findInterface(cleaned, symbol);
  if (ifaceShape) return { shape: ifaceShape, _source: "ts" };

  // 2. `type Foo = { ... }`.
  const typeShape = findTypeAlias(cleaned, symbol);
  if (typeShape) return { shape: typeShape, _source: "ts" };

  // 3. `const fooSchema = z.object({ ... })`.
  const zodShape = findZodSchema(cleaned, symbol);
  if (zodShape) return { shape: zodShape, _source: "zod" };

  return null;
}

const TS_FIELD = /^\s*([A-Za-z_$][\w$]*)\s*(\??)\s*:\s*([^;,\n]+)[;,]?$/;

function findInterface(src: string, symbol: string | null): IntentShape | null {
  const re = /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(?:extends\s+[^{]+)?\{/g;
  for (const m of src.matchAll(re)) {
    const name = m[1];
    if (symbol && name !== symbol) continue;
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchBrace(src, open);
    if (close < 0) continue;
    const body = src.slice(open + 1, close);
    return objectShapeFromBody(body, name);
  }
  return null;
}

function findTypeAlias(src: string, symbol: string | null): IntentShape | null {
  const re = /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=\s*\{/g;
  for (const m of src.matchAll(re)) {
    const name = m[1];
    if (symbol && name !== symbol) continue;
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchBrace(src, open);
    if (close < 0) continue;
    const body = src.slice(open + 1, close);
    return objectShapeFromBody(body, name);
  }
  return null;
}

function findZodSchema(src: string, symbol: string | null): IntentShape | null {
  const re = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*z\.object\s*\(\s*\{/g;
  for (const m of src.matchAll(re)) {
    const name = m[1];
    if (symbol && name !== symbol) continue;
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchBrace(src, open);
    if (close < 0) continue;
    const body = src.slice(open + 1, close);
    return zodShapeFromBody(body, name);
  }
  return null;
}

function objectShapeFromBody(body: string, name: string): IntentShape {
  const props: Record<string, IntentShape> = {};
  const required: string[] = [];

  for (const fragment of splitTopLevelLines(body, [";", ",", "\n"])) {
    const f = fragment.trim();
    if (!f) continue;
    const m = TS_FIELD.exec(f);
    if (!m) continue;
    const fieldName = m[1];
    const optional = m[2] === "?";
    const tsType = m[3].trim();
    props[fieldName] = mapTsType(tsType);
    if (!optional && !/\bundefined\b/.test(tsType)) required.push(fieldName);
  }

  return { type: "object", properties: props, required, _symbol: name };
}

function zodShapeFromBody(body: string, name: string): IntentShape {
  const props: Record<string, IntentShape> = {};
  const required: string[] = [];
  // Zod fields look like `name: z.string()`, `name: z.string().optional()`,
  // `name: z.array(z.string())`, `name: z.object({...})`. We only need
  // the leaf-most type for each field — the LLM is fine with shallow.
  for (const fragment of splitTopLevelLines(body, [","])) {
    const f = fragment.trim();
    if (!f) continue;
    const m = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(f);
    if (!m) continue;
    const fieldName = m[1];
    const expr = m[2].trim();
    props[fieldName] = mapZodExpr(expr);
    if (!/\.optional\(\s*\)/.test(expr) && !/\.nullish\(\s*\)/.test(expr)) {
      required.push(fieldName);
    }
  }
  return { type: "object", properties: props, required, _symbol: name };
}

function mapTsType(t: string): IntentShape {
  const trimmed = t.replace(/\s+/g, " ").trim().replace(/[;,]$/, "");
  // `T | undefined` / `T | null` — peel the modifier and recurse.
  const unionParts = splitTopLevelUnion(trimmed);
  if (unionParts.length > 1) {
    const nonNull = unionParts.filter((p) => !/^(undefined|null)$/.test(p));
    if (nonNull.length === 1) return mapTsType(nonNull[0]);
    // Heterogeneous union → punt to `unknown`.
    return { type: "unknown" };
  }
  if (/^Array<.+>$/.test(trimmed)) {
    const inner = trimmed.slice(6, -1);
    return { type: "array", items: mapTsType(inner) };
  }
  if (/^.+\[\]$/.test(trimmed)) {
    const inner = trimmed.slice(0, -2);
    return { type: "array", items: mapTsType(inner) };
  }
  if (trimmed === "string") return { type: "string" };
  if (trimmed === "number") return { type: "number" };
  if (trimmed === "boolean") return { type: "boolean" };
  if (trimmed === "null") return { type: "null" };
  if (trimmed === "any") return { type: "any" };
  if (trimmed === "unknown") return { type: "unknown" };
  if (trimmed === "Date") return { type: "string", format: "date-time" };
  if (/^["'].*["']$/.test(trimmed)) return { type: "string", enum: [trimmed.slice(1, -1)] };
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return { type: "number", enum: [Number(trimmed)] };
  // Reference to another type — emit symbol hint.
  return { type: "object", _symbol: trimmed };
}

function mapZodExpr(e: string): IntentShape {
  if (/^z\.string\b/.test(e)) {
    if (/\.email\(\s*\)/.test(e)) return { type: "string", format: "email" };
    if (/\.uuid\(\s*\)/.test(e)) return { type: "string", format: "uuid" };
    if (/\.url\(\s*\)/.test(e)) return { type: "string", format: "uri" };
    if (/\.datetime\(/.test(e)) return { type: "string", format: "date-time" };
    return { type: "string" };
  }
  if (/^z\.number\b/.test(e)) return { type: "number" };
  if (/^z\.boolean\b/.test(e)) return { type: "boolean" };
  if (/^z\.bigint\b/.test(e)) return { type: "number" };
  if (/^z\.date\b/.test(e)) return { type: "string", format: "date-time" };
  if (/^z\.literal\(/.test(e)) {
    const m = /^z\.literal\(\s*(.+?)\s*\)/.exec(e);
    if (m) {
      const lit = m[1];
      if (/^["'].*["']$/.test(lit)) return { type: "string", enum: [lit.slice(1, -1)] };
      if (/^-?\d+(\.\d+)?$/.test(lit)) return { type: "number", enum: [Number(lit)] };
      if (lit === "true" || lit === "false") return { type: "boolean", enum: [lit === "true"] };
    }
    return { type: "unknown" };
  }
  if (/^z\.enum\(\s*\[/.test(e)) {
    const inner = /^z\.enum\(\s*\[([\s\S]+?)\]/.exec(e);
    if (inner) {
      const values = inner[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      return { type: "string", enum: values };
    }
    return { type: "string" };
  }
  if (/^z\.array\(/.test(e)) {
    const inner = unwrapZodCall(e, "array");
    return { type: "array", items: inner ? mapZodExpr(inner) : { type: "unknown" } };
  }
  if (/^z\.object\(\s*\{/.test(e)) {
    return { type: "object" }; // shallow — caller decides whether to recurse
  }
  if (/^z\.record\(/.test(e)) return { type: "object" };
  return { type: "unknown" };
}

function unwrapZodCall(expr: string, name: string): string | null {
  const start = expr.indexOf(`z.${name}(`);
  if (start !== 0) return null;
  const open = expr.indexOf("(", start);
  if (open < 0) return null;
  const close = matchParen(expr, open);
  if (close < 0) return null;
  return expr.slice(open + 1, close).trim();
}

// ─── Parsing helpers (brace/paren matching, top-level splitting) ──────────

function matchBrace(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x7b /* { */) depth++;
    else if (c === 0x7d /* } */) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x28 /* ( */) depth++;
    else if (c === 0x29 /* ) */) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelLines(s: string, separators: string[]): string[] {
  const out: string[] = [];
  let depthBrace = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthAngle = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depthBrace++;
    else if (c === "}") depthBrace = Math.max(0, depthBrace - 1);
    else if (c === "(") depthParen++;
    else if (c === ")") depthParen = Math.max(0, depthParen - 1);
    else if (c === "[") depthBracket++;
    else if (c === "]") depthBracket = Math.max(0, depthBracket - 1);
    else if (c === "<") depthAngle++;
    else if (c === ">") depthAngle = Math.max(0, depthAngle - 1);
    if (depthBrace === 0 && depthParen === 0 && depthBracket === 0 && depthAngle === 0 && separators.includes(c)) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function splitTopLevelUnion(s: string): string[] {
  const out: string[] = [];
  let depthBrace = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthAngle = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depthBrace++;
    else if (c === "}") depthBrace = Math.max(0, depthBrace - 1);
    else if (c === "(") depthParen++;
    else if (c === ")") depthParen = Math.max(0, depthParen - 1);
    else if (c === "[") depthBracket++;
    else if (c === "]") depthBracket = Math.max(0, depthBracket - 1);
    else if (c === "<") depthAngle++;
    else if (c === ">") depthAngle = Math.max(0, depthAngle - 1);
    if (
      c === "|" && depthBrace === 0 && depthParen === 0 && depthBracket === 0 && depthAngle === 0
    ) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) out.push(cur.trim());
  return out;
}

function capShapeSize(shape: IntentShape): IntentShape {
  const json = (() => { try { return JSON.stringify(shape) ?? ""; } catch { return ""; } })();
  if (json.length <= MAX_SHAPE_BYTES) return shape;
  return { type: shape.type ?? "object", _symbol: shape._symbol, _truncated: true };
}

// ─── Mutation helper ──────────────────────────────────────────────────────

function attach(event: Record<string, unknown>, contract: IntentContract, _file: string): void {
  const expected = (event.expected ?? {}) as { contracts?: IntentContract[] };
  const next = Array.isArray(expected.contracts) ? [...expected.contracts] : [];
  next.push(contract);
  event.expected = { ...expected, contracts: next };
}
