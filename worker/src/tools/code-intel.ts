/**
 * Code Intelligence v2 — worker-side tool wrappers.
 *
 * Phase 1.6 of CODE_INTELLIGENCE_V2_HANDOFF.md. The container agent (worker)
 * gains 3 new tools:
 *   - find_references(symbol_fqn, kind?)
 *   - type_at(file_path, line, col?)
 *   - blast_radius(symbol_fqn, depth?)
 *
 * Each tool is a thin HTTP shim over `/api/code-intel-v2/*` on the web app.
 * The web endpoint resolves the projectId → repoId server-side and runs the
 * canonical query from `web/lib/code-intelligence-v2/queries.ts`.
 *
 * Flag: CODE_INTEL_V2_TOOLS=on enables the tools in the worker's tool list.
 * Default OFF — Phase 3 cutover decides when to flip globally. Per the
 * handoff: "Container agent tools rollout: add immediately on Phase 1, gate
 * via flag (worker reads CODE_INTEL_V2_TOOLS=on|off env)."
 */

import type { ToolDefinition } from "../ai-client.js";

const FLAG_ENV = "CODE_INTEL_V2_TOOLS";

export function isCodeIntelV2ToolsEnabled(): boolean {
  return (process.env[FLAG_ENV] ?? "").toLowerCase().trim() === "on";
}

export const CODE_INTEL_V2_TOOLS: ToolDefinition[] = [
  {
    name: "find_references",
    description:
      "Find every USE-site of a symbol (calls, imports, type refs, extends, JSX). " +
      "Returns one row per reference with file_path:line. Use BEFORE editing a function " +
      "to know who depends on it. Faster and more precise than grep — driven by exact " +
      "type-checker resolution. Requires a v2-indexed repo (CODE_INTEL_V2 enabled).",
    input_schema: {
      type: "object",
      properties: {
        symbol_fqn: {
          type: "string",
          description: "Fully-qualified name. Format: '<file>::<owner_chain>'. Example 'src/auth/login.ts::validateUser'.",
        },
        kind: {
          type: "string",
          description: "Optional symbol kind to disambiguate declaration merging (function | class | method | type | variable | interface | enum | namespace).",
        },
      },
      required: ["symbol_fqn"],
    },
  },
  {
    name: "type_at",
    description:
      "Return the symbol enclosing a file:line (with type info when available). " +
      "Use when you have a stack-trace frame and need to know which function it lands in. " +
      "Innermost-symbol-wins; falls back to outer scopes if the line is between members.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Repo-relative file path (e.g. 'src/auth/login.ts')." },
        line: { type: "integer", description: "1-based line number." },
        col: { type: "integer", description: "Optional 0-based column." },
      },
      required: ["file_path", "line"],
    },
  },
  {
    name: "blast_radius",
    description:
      "Transitive caller closure of a symbol. Returns up to 5 hops out the dependency " +
      "graph. Use BEFORE making non-trivial changes to know what could regress. " +
      "Smaller results = safer change. Default depth=2.",
    input_schema: {
      type: "object",
      properties: {
        symbol_fqn: { type: "string", description: "Fully-qualified name. See find_references for format." },
        depth: { type: "integer", description: "How many hops to follow. 1-5. Default 2." },
      },
      required: ["symbol_fqn"],
    },
  },
];

// ── HTTP execution ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5000;

interface ExecCtx {
  webUrl: string;       // e.g. "https://app.inariwatch.com"
  cronSecret: string;   // shared with web; same secret as other internal endpoints
  projectId: string | null;
  repoId?: string | null;
  /**
   * Phase 3.2 — when present, overrides the env-only enable check. The
   * A/B router passes `true` for the v2 cohort so the tools fire even
   * when the global `CODE_INTEL_V2_TOOLS` flag is off, and `false` for
   * the v1 cohort (defense-in-depth — the tool list builder also blocks).
   */
  forceEnabled?: boolean;
}

export interface ToolInputFindReferences {
  symbol_fqn: string;
  kind?: string;
}

export interface ToolInputTypeAt {
  file_path: string;
  line: number;
  col?: number;
}

export interface ToolInputBlastRadius {
  symbol_fqn: string;
  depth?: number;
}

export type CodeIntelToolName = "find_references" | "type_at" | "blast_radius";

export async function executeCodeIntelTool(
  name: CodeIntelToolName,
  input: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<string> {
  const enabled = typeof ctx.forceEnabled === "boolean" ? ctx.forceEnabled : isCodeIntelV2ToolsEnabled();
  if (!enabled) {
    return `Error: ${name} is not enabled (CODE_INTEL_V2_TOOLS=off).`;
  }
  if (!ctx.cronSecret) {
    return `Error: ${name} cannot run — CRON_SECRET not set in worker env.`;
  }
  if (!ctx.projectId && !ctx.repoId) {
    return `Error: ${name} cannot run — neither projectId nor repoId is available on this session.`;
  }

  const path = `/api/code-intel-v2/${name.replace(/_/g, "-")}`;
  const body: Record<string, unknown> = {
    projectId: ctx.projectId,
    repoId: ctx.repoId,
  };

  if (name === "find_references") {
    const inp = input as ToolInputFindReferences;
    if (!inp.symbol_fqn) return "Error: symbol_fqn is required.";
    body.symbolFqn = inp.symbol_fqn;
    if (inp.kind) body.kind = inp.kind;
  } else if (name === "type_at") {
    const inp = input as ToolInputTypeAt;
    if (!inp.file_path) return "Error: file_path is required.";
    if (typeof inp.line !== "number") return "Error: line is required.";
    body.filePath = inp.file_path;
    body.line = inp.line;
    if (typeof inp.col === "number") body.col = inp.col;
  } else if (name === "blast_radius") {
    const inp = input as ToolInputBlastRadius;
    if (!inp.symbol_fqn) return "Error: symbol_fqn is required.";
    body.symbolFqn = inp.symbol_fqn;
    if (typeof inp.depth === "number") body.depth = inp.depth;
  }

  return callWebApi(`${ctx.webUrl}${path}`, body, ctx.cronSecret);
}

async function callWebApi(
  url: string,
  body: Record<string, unknown>,
  cronSecret: string,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return `Error: ${url} → ${res.status} ${res.statusText}: ${text.slice(0, 500)}`;
    return text;
  } catch (err) {
    return `Error: HTTP request failed: ${(err as Error).message}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Helper for tests: build the full tool list for a worker turn given the
 * current flag state. Production wiring should compose this with the main
 * tool-list builder in container-agent.ts.
 *
 * Phase 3.2 — `forceEnabled` lets the A/B router override the env. When
 * the worker has decided this session belongs to the v2 cohort the v2
 * tools must appear regardless of the global `CODE_INTEL_V2_TOOLS` flag;
 * conversely the v1 cohort must never see the v2 tools even if the env
 * is on. Undefined keeps the Phase 1.6 behavior (env decides).
 */
export function appendCodeIntelV2Tools(
  base: ToolDefinition[],
  forceEnabled?: boolean,
): ToolDefinition[] {
  const enabled = typeof forceEnabled === "boolean" ? forceEnabled : isCodeIntelV2ToolsEnabled();
  return enabled ? [...base, ...CODE_INTEL_V2_TOOLS] : base;
}
