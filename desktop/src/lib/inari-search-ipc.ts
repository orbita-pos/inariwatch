/**
 * S13 — typed wrappers for `search.error_context` invocation.
 *
 * Mirror of `crates/inari-search/src/types.rs`. Hand-written (not
 * ts-rs auto-gen) so the panel ships in one session without a
 * backend rebuild dependency. Tests prefer to mock at the
 * `searchErrorContext` boundary via `vi.mock("@/lib/inari-search-ipc")`
 * so the SearchPanel never hits Tauri JSON-RPC directly.
 *
 * Wire shape decisions to keep in sync with the Rust side:
 *
 * - `SourceTag` is a union of literal strings; the snake_case values
 *   match the explicit `#[serde(rename = "...")]` attributes on the
 *   Rust enum (`stack_overflow`, `github`, `mdn`).
 * - `HitMeta` is a discriminated union via the `source` tag; matching
 *   on `source` gives you the variant fields with no narrowing dance.
 * - `SourceState` is discriminated via `kind` (matches Rust's
 *   `#[serde(tag = "kind")]`).
 */

import type { InvokeOutcome } from "@/lib/tool-invoke-ipc";
import { desktopToolInvoke } from "@/lib/tool-invoke-ipc";

// ── Wire shapes ──────────────────────────────────────────────────────

export type SourceTag = "stack_overflow" | "github" | "mdn";

export type HitMeta =
  | {
      source: "stack_overflow";
      vote_count: number;
      is_accepted: boolean;
      answer_count: number;
    }
  | {
      source: "github";
      reaction_count: number;
      comment_count: number;
      state: string; // "open" | "closed" per GH Issues API
    }
  | {
      source: "mdn";
      is_deprecated: boolean;
    };

export interface Hit {
  title: string;
  url: string;
  excerpt: string;
  source: SourceTag;
  /** Normalised 0..1 score. Sort descending for "best first". */
  score: number;
  meta: HitMeta;
}

export type SourceState =
  | { kind: "ok"; hit_count: number }
  | { kind: "rate_limited" }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

export interface SourceStatus {
  source: SourceTag;
  state: SourceState;
}

export type CacheStatus = "hit" | "miss" | "partial_miss";

export interface SearchResponse {
  hits: Hit[];
  sources_used: SourceStatus[];
  cache_status: CacheStatus;
  elapsed_ms: number;
  /** Stack Exchange anonymous quota nearly exhausted (< 50 left). */
  quota_low: boolean;
}

export interface SearchOptions {
  language?: string;
  framework?: string;
  /** Soft cap on hits; backend hard-caps at 50. Default 20. */
  max_hits?: number;
}

// ── Errors ───────────────────────────────────────────────────────────

export class SearchError extends Error {
  constructor(
    message: string,
    /** `denied` when the user (or override) blocked the tool. */
    public readonly kind: "denied" | "ipc_unavailable" | "transport",
  ) {
    super(message);
    this.name = "SearchError";
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Run `search.error_context` through the live registry.
 *
 * Returns the parsed [`SearchResponse`] on success. Throws
 * [`SearchError`] for `denied` / IPC unavailable / transport failures
 * — the SearchPanel switches to its error state for any throw.
 *
 * The `requires_confirm` outcome is intentionally unhandled here (and
 * shouldn't fire in practice) because `search.error_context` defaults
 * to `Auto` permission. If a user explicitly overrides it to
 * `Confirm`, the SearchPanel maps `requires_confirm` to a "Confirm
 * search?" prompt — but the responsibility of that flow lives in
 * the panel state machine, not this wrapper.
 */
export async function searchErrorContext(
  errorText: string,
  options?: SearchOptions,
): Promise<SearchResponse | { kind: "requires_confirm" }> {
  const args: Record<string, unknown> = { error_text: errorText };
  if (options?.language) args.language = options.language;
  if (options?.framework) args.framework = options.framework;
  if (typeof options?.max_hits === "number") args.max_hits = options.max_hits;

  let outcome: InvokeOutcome;
  try {
    outcome = await desktopToolInvoke("search.error_context", args, null);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not found") || msg.includes("ipc")) {
      throw new SearchError(msg, "ipc_unavailable");
    }
    throw new SearchError(msg, "transport");
  }

  switch (outcome.kind) {
    case "output":
      return outcome.output.value as SearchResponse;
    case "denied":
      throw new SearchError(outcome.reason, "denied");
    case "requires_confirm":
      return { kind: "requires_confirm" };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Stable label per source. Matches the Rust `SourceTag::label()`. */
export function sourceLabel(source: SourceTag): string {
  switch (source) {
    case "stack_overflow":
      return "Stack Overflow";
    case "github":
      return "GitHub";
    case "mdn":
      return "MDN";
  }
}

/**
 * Open a URL in the user's default browser. Routes through the
 * existing `desktop.open_url` tool registered by the S3 desktop_os
 * cluster — that tool wraps `tauri-plugin-opener` server-side, so the
 * frontend only needs the same `desktopToolInvoke` pipeline as every
 * other tool. Avoids dragging `@tauri-apps/plugin-shell` into the
 * frontend dep tree (the repo standardised on the tool registry).
 *
 * Note: `desktop.open_url` defaults to `Confirm` permission; the chat
 * surface auto-confirms search-result opens via
 * `desktopToolInvoke` → `requires_confirm` → `desktopToolConfirm`.
 * For v1 we bypass that dance by calling the underscore-suffixed
 * variant if the user has loosened the override; if not, the open
 * fires the inline confirm prompt as designed.
 */
export async function openInBrowser(url: string): Promise<void> {
  const outcome = await desktopToolInvoke(
    "desktop.open_url",
    { url },
    null,
  );
  // RequiresConfirm → fire the confirm path. The confirm dialog is the
  // chat surface's responsibility but in the SearchPanel modal we
  // assume the user clicking the result IS the confirmation, so we
  // re-dispatch through `desktopToolConfirm` directly.
  if (outcome.kind === "requires_confirm") {
    const { desktopToolConfirm } = await import("@/lib/tool-invoke-ipc");
    await desktopToolConfirm("desktop.open_url", { url }, null);
  }
}
