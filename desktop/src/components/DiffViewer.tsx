import { motion, useReducedMotion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";

import { cn } from "@/lib/cn";
import {
  parseUnifiedDiff,
  type DiffHunk,
  type DiffLine,
  type ParsedDiff,
} from "@/lib/diff/parser";

const SPLIT_STORAGE_KEY = "inari.diff.split";
const DEFAULT_SPLIT = 50;

export type DiffViewMode = "inline" | "side-by-side";

interface DiffViewerProps {
  /** Unified-diff string (per-file). The component handles parsing internally. */
  diff: string;
  /** Shiki language id (typescript / javascript / rust / …). */
  language: string;
  /** View mode. Parent owns the toggle so the badge + view stay in sync. */
  mode: DiffViewMode;
  /** Optional className applied to the outer wrapper. */
  className?: string;
}

interface ShikiTokenLine {
  /** Pre-tokenised HTML for the line, without the surrounding `<pre>`. */
  html: string;
}

interface ShikiBlocks {
  /** Old-side tokens, indexed by old-side line number (1-based). */
  old: Map<number, ShikiTokenLine>;
  /** New-side tokens, indexed by new-side line number (1-based). */
  new: Map<number, ShikiTokenLine>;
}

const SHIKI_LANG_FALLBACK = "plaintext";

async function highlightSides(
  hunks: DiffHunk[],
  language: string,
): Promise<ShikiBlocks> {
  // Build the old-side and new-side string projections so Shiki can
  // tokenise each as a real source file rather than tokenising line-
  // by-line (which loses block-level context like multi-line strings).
  const old: { lineNo: number; content: string }[] = [];
  const fresh: { lineNo: number; content: string }[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.oldLineNo !== null) {
        old.push({ lineNo: line.oldLineNo, content: line.content });
      }
      if (line.newLineNo !== null) {
        fresh.push({ lineNo: line.newLineNo, content: line.content });
      }
    }
  }
  const oldText = old.map((l) => l.content).join("\n");
  const newText = fresh.map((l) => l.content).join("\n");

  let oldHtml: string[] = old.map((l) => escapeHtml(l.content));
  let newHtml: string[] = fresh.map((l) => escapeHtml(l.content));
  try {
    const { codeToHtml } = await import("shiki");
    const shikiLang = language || SHIKI_LANG_FALLBACK;
    const oldRendered = await codeToHtml(oldText, {
      lang: shikiLang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
    const newRendered = await codeToHtml(newText, {
      lang: shikiLang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
    oldHtml = extractLinesFromShiki(oldRendered, old.length);
    newHtml = extractLinesFromShiki(newRendered, fresh.length);
  } catch {
    // Unknown language or shiki failure — keep the escaped fallback.
  }

  const oldMap = new Map<number, ShikiTokenLine>();
  old.forEach((l, idx) => {
    oldMap.set(l.lineNo, { html: oldHtml[idx] ?? escapeHtml(l.content) });
  });
  const newMap = new Map<number, ShikiTokenLine>();
  fresh.forEach((l, idx) => {
    newMap.set(l.lineNo, { html: newHtml[idx] ?? escapeHtml(l.content) });
  });
  return { old: oldMap, new: newMap };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const SHIKI_LINE_RE = /<span class="line">([\s\S]*?)<\/span>/g;

function extractLinesFromShiki(html: string, expected: number): string[] {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = SHIKI_LINE_RE.exec(html)) !== null) {
    matches.push(m[1] ?? "");
  }
  // Shiki may add a trailing empty line — pad/truncate to `expected`.
  while (matches.length < expected) matches.push("");
  return matches.slice(0, expected);
}

const TYPE_BG: Record<DiffLine["type"], string> = {
  add: "bg-[color:color-mix(in_oklch,var(--color-success)_15%,transparent)]",
  del: "bg-[color:color-mix(in_oklch,var(--color-danger)_15%,transparent)]",
  context: "bg-transparent",
};

const TYPE_PREFIX: Record<DiffLine["type"], string> = {
  add: "+",
  del: "-",
  context: " ",
};

const TYPE_PREFIX_TONE: Record<DiffLine["type"], string> = {
  add: "text-[var(--color-success)]",
  del: "text-[var(--color-danger)]",
  context: "text-[var(--muted)]",
};

interface HunkVisibility {
  [hunkIndex: number]: boolean;
}

/**
 * Diff viewer — the money-shot screen of the dock. Custom-built on top
 * of Shiki rather than `@git-diff-view/react` so syntax highlighting is
 * pixel-identical to ChatMessage.tsx + the rest of the dock surface.
 *
 * Inline mode renders one stream of `+` / `-` / context lines.
 * Side-by-side mode renders two synchronised columns via
 * `react-resizable-panels`. The split ratio persists in localStorage
 * (`inari.diff.split`) so the user's preference survives reloads.
 *
 * Hunk headers collapse on click via Framer's `layout` animation; the
 * "Show more context" button between hunks is a UI stub today (the
 * fix backend is wired in Sesión 17/19).
 */
export function DiffViewer({ diff, language, mode, className }: DiffViewerProps) {
  const parsed: ParsedDiff = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [shiki, setShiki] = useState<ShikiBlocks | null>(null);
  const [hunkOpen, setHunkOpen] = useState<HunkVisibility>({});
  const reduce = useReducedMotion();

  // Lazily highlight the diff once the parse is ready.
  useEffect(() => {
    if (parsed.binary || parsed.hunks.length === 0) return;
    let cancelled = false;
    highlightSides(parsed.hunks, language).then((blocks) => {
      if (!cancelled) setShiki(blocks);
    });
    return () => {
      cancelled = true;
    };
  }, [parsed, language]);

  const toggleHunk = (idx: number) => {
    setHunkOpen((prev) => ({ ...prev, [idx]: prev[idx] === false }));
  };

  if (parsed.binary) {
    return (
      <div
        data-testid="diff-viewer"
        data-mode={mode}
        data-binary="true"
        className={cn(
          "flex items-center justify-center p-6 text-sm text-[var(--muted)]",
          "border border-dashed border-[var(--border)] rounded-[var(--radius-md)]",
          className,
        )}
      >
        Binary file — diff cannot be displayed.
      </div>
    );
  }

  if (parsed.hunks.length === 0) {
    return (
      <div
        data-testid="diff-viewer"
        data-mode={mode}
        data-empty="true"
        className={cn(
          "flex items-center justify-center p-6 text-sm text-[var(--muted)]",
          className,
        )}
      >
        No changes.
      </div>
    );
  }

  const renderHunkHeader = (hunk: DiffHunk, idx: number) => {
    const open = hunkOpen[idx] !== false;
    return (
      <button
        type="button"
        onClick={() => toggleHunk(idx)}
        data-testid="diff-hunk-header"
        data-hunk-open={open ? "true" : "false"}
        aria-expanded={open}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1",
          "text-[0.7rem] font-[var(--font-mono)] text-[var(--muted)]",
          "bg-[var(--surface)] border-y border-[var(--border)]",
          "hover:bg-[color:color-mix(in_oklch,var(--surface)_80%,var(--bg))]",
        )}
      >
        <motion.span
          aria-hidden
          animate={reduce ? undefined : { rotate: open ? 0 : -90 }}
          transition={{ duration: 0.15 }}
        >
          <ChevronDown className="h-3 w-3" />
        </motion.span>
        <span className="font-mono">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </span>
        {hunk.heading ? (
          <span className="text-[var(--text)] truncate ml-2">{hunk.heading}</span>
        ) : null}
      </button>
    );
  };

  return (
    <div
      data-testid="diff-viewer"
      data-mode={mode}
      data-hunk-count={parsed.hunks.length}
      className={cn(
        "border border-[var(--border)] rounded-[var(--radius-md)]",
        "bg-[var(--bg)] overflow-hidden",
        className,
      )}
    >
      {parsed.hunks.map((hunk, idx) => {
        const open = hunkOpen[idx] !== false;
        return (
          <motion.div
            key={`hunk-${idx}`}
            layout={reduce ? false : "size"}
            transition={
              reduce ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }
            }
            data-testid="diff-hunk"
          >
            {renderHunkHeader(hunk, idx)}
            {open ? (
              mode === "inline" ? (
                <InlineHunk
                  hunk={hunk}
                  shiki={shiki}
                  data-hunk-index={idx}
                />
              ) : (
                <SideBySideHunk hunk={hunk} shiki={shiki} />
              )
            ) : null}
            {idx < parsed.hunks.length - 1 ? (
              <button
                type="button"
                data-testid="diff-show-context"
                className={cn(
                  "w-full text-[0.65rem] py-1",
                  "text-[var(--muted)] hover:text-[var(--text)]",
                  "bg-[var(--bg)] border-t border-[var(--border)]",
                )}
                onClick={() =>
                  console.info(
                    "[diff-viewer] show context — wires to backend in Sesión 19",
                  )
                }
              >
                ↕ Show more context
              </button>
            ) : null}
          </motion.div>
        );
      })}
    </div>
  );
}

interface InlineHunkProps {
  hunk: DiffHunk;
  shiki: ShikiBlocks | null;
}

function InlineHunk({ hunk, shiki }: InlineHunkProps) {
  return (
    <div
      data-testid="diff-hunk-inline"
      className="font-[var(--font-mono)] text-xs"
    >
      {hunk.lines.map((line, idx) => (
        <DiffLineRow key={idx} line={line} shiki={shiki} side="inline" />
      ))}
    </div>
  );
}

interface SideBySideHunkProps {
  hunk: DiffHunk;
  shiki: ShikiBlocks | null;
}

function loadInitialSplit(): number {
  if (typeof window === "undefined") return DEFAULT_SPLIT;
  const raw = window.localStorage?.getItem(SPLIT_STORAGE_KEY);
  const parsed = raw ? parseFloat(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 10 && parsed <= 90) {
    return parsed;
  }
  return DEFAULT_SPLIT;
}

function persistSplit(split: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(SPLIT_STORAGE_KEY, split.toFixed(1));
  } catch {
    // Quota / private mode — silently ignore; we always have a default.
  }
}

function SideBySideHunk({ hunk, shiki }: SideBySideHunkProps) {
  const [split, setSplit] = useState(loadInitialSplit);
  // Synchronise vertical scroll between the two columns.
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  const onLeftScroll = useCallback(() => {
    if (syncing.current) return;
    if (!leftRef.current || !rightRef.current) return;
    syncing.current = true;
    rightRef.current.scrollTop = leftRef.current.scrollTop;
    syncing.current = false;
  }, []);

  const onRightScroll = useCallback(() => {
    if (syncing.current) return;
    if (!leftRef.current || !rightRef.current) return;
    syncing.current = true;
    leftRef.current.scrollTop = rightRef.current.scrollTop;
    syncing.current = false;
  }, []);

  // Project one row per old-side line + one row per new-side line. For
  // pure adds the old side gets a phantom blank row; for pure dels the
  // new side gets one. Context appears on both sides at the same row.
  const rows = useMemo(() => buildSideBySideRows(hunk), [hunk]);

  const onLayout = (sizes: number[]) => {
    if (sizes.length >= 1 && Number.isFinite(sizes[0])) {
      const next = Math.round(sizes[0]! * 10) / 10;
      setSplit(next);
      persistSplit(next);
    }
  };

  return (
    <div data-testid="diff-hunk-split" data-split={split.toFixed(1)}>
      <PanelGroup
        direction="horizontal"
        onLayout={onLayout}
        className="font-[var(--font-mono)] text-xs"
      >
        <Panel defaultSize={split} minSize={10} order={1}>
          <div
            ref={leftRef}
            onScroll={onLeftScroll}
            className="overflow-auto max-h-[400px]"
            data-testid="diff-side-old"
          >
            {rows.map((row, idx) => (
              <DiffLineRow
                key={`old-${idx}`}
                line={row.left}
                shiki={shiki}
                side="old"
              />
            ))}
          </div>
        </Panel>
        <PanelResizeHandle
          aria-label="Resize split"
          className="w-px bg-[var(--border)] hover:bg-[var(--color-primary)] cursor-col-resize transition-colors duration-[var(--duration-fast)]"
        />
        <Panel defaultSize={100 - split} minSize={10} order={2}>
          <div
            ref={rightRef}
            onScroll={onRightScroll}
            className="overflow-auto max-h-[400px]"
            data-testid="diff-side-new"
          >
            {rows.map((row, idx) => (
              <DiffLineRow
                key={`new-${idx}`}
                line={row.right}
                shiki={shiki}
                side="new"
              />
            ))}
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}

interface SideBySideRow {
  left: DiffLine;
  right: DiffLine;
}

function emptyContext(): DiffLine {
  return { type: "context", content: "", oldLineNo: null, newLineNo: null };
}

function buildSideBySideRows(hunk: DiffHunk): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let i = 0;
  while (i < hunk.lines.length) {
    const line = hunk.lines[i]!;
    if (line.type === "context") {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }
    // Try to pair adjacent del+add as one row (the "edit" case).
    if (line.type === "del") {
      const next = hunk.lines[i + 1];
      if (next && next.type === "add") {
        rows.push({ left: line, right: next });
        i += 2;
        continue;
      }
      rows.push({ left: line, right: emptyContext() });
      i += 1;
      continue;
    }
    if (line.type === "add") {
      rows.push({ left: emptyContext(), right: line });
      i += 1;
      continue;
    }
    i += 1;
  }
  return rows;
}

interface DiffLineRowProps {
  line: DiffLine;
  shiki: ShikiBlocks | null;
  side: "inline" | "old" | "new";
}

function DiffLineRow({ line, shiki, side }: DiffLineRowProps) {
  const html = useMemo(() => {
    if (!shiki) return escapeHtml(line.content);
    if (side === "old" && line.oldLineNo !== null) {
      return shiki.old.get(line.oldLineNo)?.html ?? escapeHtml(line.content);
    }
    if (side === "new" && line.newLineNo !== null) {
      return shiki.new.get(line.newLineNo)?.html ?? escapeHtml(line.content);
    }
    if (side === "inline") {
      // Prefer new-side highlighting for adds + context; old-side for
      // dels. Falls back to escaped text when either side is empty.
      if (line.type === "add" && line.newLineNo !== null) {
        return shiki.new.get(line.newLineNo)?.html ?? escapeHtml(line.content);
      }
      if (line.type === "del" && line.oldLineNo !== null) {
        return shiki.old.get(line.oldLineNo)?.html ?? escapeHtml(line.content);
      }
      if (line.newLineNo !== null) {
        return shiki.new.get(line.newLineNo)?.html ?? escapeHtml(line.content);
      }
      if (line.oldLineNo !== null) {
        return shiki.old.get(line.oldLineNo)?.html ?? escapeHtml(line.content);
      }
    }
    return escapeHtml(line.content);
  }, [shiki, line, side]);

  const lineNumberStyle: CSSProperties = {
    minWidth: "3.5rem",
    textAlign: "right",
  };

  return (
    <div
      data-testid="diff-line"
      data-line-type={line.type}
      data-line-side={side}
      className={cn(
        "flex items-start gap-2 px-2",
        "leading-[1.5rem]",
        TYPE_BG[line.type],
      )}
    >
      {side === "inline" || side === "old" ? (
        <span
          className="text-[0.65rem] text-[var(--muted)] select-none pt-[2px]"
          style={lineNumberStyle}
        >
          {line.oldLineNo ?? ""}
        </span>
      ) : null}
      {side === "inline" || side === "new" ? (
        <span
          className="text-[0.65rem] text-[var(--muted)] select-none pt-[2px]"
          style={lineNumberStyle}
        >
          {line.newLineNo ?? ""}
        </span>
      ) : null}
      <span
        aria-hidden
        className={cn(
          "select-none w-3 shrink-0 pt-[2px] text-[0.7rem]",
          TYPE_PREFIX_TONE[line.type],
        )}
      >
        {TYPE_PREFIX[line.type]}
      </span>
      <span
        className="flex-1 whitespace-pre [&_pre]:!bg-transparent [&_pre]:m-0"
        data-testid="diff-line-content"
        // Shiki escapes content at source; the fallback path uses
        // `escapeHtml`. No injection vector from the diff string.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
