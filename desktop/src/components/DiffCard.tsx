import { ChevronDown, ChevronRight, Copy, FileCode } from "lucide-react";
import { useMemo, useState } from "react";

/**
 * Diff card for fenced ```diff blocks in assistant messages.
 *
 * Per the 2026-05-07 design comp (Frame B1 + B2):
 *
 *   - 52 px header bar — file icon + path mono + line range + chevron
 *     toggle ("Show diff" / "Hide diff") + +N/-N badges + truncated
 *     SHA mono with copy affordance.
 *   - Same chrome on both states; only the chevron rotates and the
 *     toggle label flips. Expanding reveals the body below the bar
 *     with its own hairline top border.
 *   - Body — 3-column grid of `gutter-line# / sign / code` with
 *     syntax-tinted code (sage keywords, gold functions, warm strings,
 *     soft purple numbers — already in tokens).
 *   - Removed lines get `rgba(201,125,125,0.07)` row bg, `−` sign red.
 *   - Added lines get `rgba(143,185,150,0.07)` row bg, `+` sign sage.
 *   - Footer — "N lines changed across 1 file · review locally before
 *     applying".
 *
 * The parser is unified-diff aware: it picks the file path off the
 * `+++ b/...` header, the start line off `@@ -X,Y +Z,W @@`, and
 * accumulates line-by-line rows. If the input doesn't carry headers
 * (raw `+ / - /  ` lines only) it falls back to "untitled" + 1-based
 * line numbering — still legible.
 */
export interface DiffCardProps {
  /** Raw fenced-block content, with or without unified-diff headers. */
  diff: string;
  /**
   * Optional override for the SHA chip on the right of the header.
   * When omitted we derive a stable short hash from the diff content.
   */
  sha?: string;
  className?: string;
  testId?: string;
}

interface DiffLine {
  kind: "ctx" | "add" | "rm" | "hunk" | "meta";
  /** Line number on the destination side (after the patch). */
  newLine: number | null;
  text: string;
}

interface ParsedDiff {
  filePath: string;
  startLine: number;
  endLine: number;
  added: number;
  removed: number;
  lines: DiffLine[];
}

const HUNK_RE = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;

function parseDiff(raw: string): ParsedDiff {
  const trimmed = raw.replace(/^\n+|\n+$/g, "");
  const all = trimmed.split("\n");

  let filePath = "untitled";
  let startLine = 0;
  let hunkSize = 0;
  let added = 0;
  let removed = 0;
  const lines: DiffLine[] = [];
  let cursor = 0; // line number on the new side
  let sawHunk = false;

  for (const ln of all) {
    if (ln.startsWith("+++ b/")) {
      filePath = ln.slice(6);
      lines.push({ kind: "meta", newLine: null, text: ln });
      continue;
    }
    if (ln.startsWith("--- a/")) {
      lines.push({ kind: "meta", newLine: null, text: ln });
      continue;
    }
    if (ln.startsWith("diff --git") || ln.startsWith("index ")) {
      lines.push({ kind: "meta", newLine: null, text: ln });
      continue;
    }
    const hm = HUNK_RE.exec(ln);
    if (hm) {
      sawHunk = true;
      startLine = startLine || parseInt(hm[1] ?? "1", 10);
      hunkSize += parseInt(hm[2] ?? "0", 10);
      cursor = parseInt(hm[1] ?? "1", 10) - 1;
      lines.push({ kind: "hunk", newLine: null, text: ln });
      continue;
    }

    // Fall-through: actual diff content. If we never saw a hunk
    // header, treat the file as starting at line 1 and increment.
    if (!sawHunk && cursor === 0) {
      cursor = 0;
    }

    if (ln.startsWith("+")) {
      cursor += 1;
      added += 1;
      lines.push({
        kind: "add",
        newLine: cursor,
        text: ln.slice(1),
      });
    } else if (ln.startsWith("-")) {
      removed += 1;
      lines.push({
        kind: "rm",
        // Removed lines don't have a new-side line number — reuse the
        // last cursor for visual alignment without claiming a number.
        newLine: null,
        text: ln.slice(1),
      });
    } else if (ln.startsWith(" ")) {
      cursor += 1;
      lines.push({
        kind: "ctx",
        newLine: cursor,
        text: ln.slice(1),
      });
    } else if (ln.length === 0) {
      // Empty line in the diff — treat as context.
      cursor += 1;
      lines.push({ kind: "ctx", newLine: cursor, text: "" });
    } else {
      // Unknown prefix — render verbatim as context so we don't drop
      // content. (e.g. `\ No newline at end of file` markers.)
      lines.push({ kind: "meta", newLine: null, text: ln });
    }
  }

  const endLine = startLine + hunkSize > 0 ? startLine + hunkSize - 1 : cursor;

  return { filePath, startLine: startLine || 1, endLine, added, removed, lines };
}

function deriveSha(text: string): string {
  // FNV-1a 32-bit, formatted like a git short SHA. Stable per
  // identical content; no real cryptography here.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

export function DiffCard({ diff, sha, className, testId }: DiffCardProps) {
  const parsed = useMemo(() => parseDiff(diff), [diff]);
  const shaShort = sha ?? `${deriveSha(diff)}…`;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const renderableLines = parsed.lines.filter((l) => l.kind !== "meta");
  const lineCount = renderableLines.filter(
    (l) => l.kind === "add" || l.kind === "rm" || l.kind === "ctx",
  ).length;

  const onCopySha = async () => {
    try {
      await navigator.clipboard.writeText(shaShort.replace(/…$/, ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* silent */
    }
  };

  return (
    <div
      data-testid={testId ?? "diff-card"}
      data-open={open ? "true" : "false"}
      className={["my-3 rounded-[10px] overflow-hidden", className]
        .filter(Boolean)
        .join(" ")}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border-strong)",
      }}
    >
      <div
        className="flex items-center gap-3 px-3.5"
        style={{ height: 52 }}
      >
        <FileCode size={13} strokeWidth={1.6} style={{ color: "var(--text-subtle)" }} />
        <div className="flex items-baseline gap-1.5 min-w-0 flex-1">
          <span
            className="text-[12.5px] truncate"
            style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}
          >
            {parsed.filePath}
          </span>
          <span
            className="text-[11.5px] shrink-0"
            style={{ fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}
          >
            · L{parsed.startLine}-{parsed.endLine}
          </span>
        </div>

        <button
          type="button"
          data-testid="diff-card-toggle"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1.5 transition-colors hover:bg-white/[0.025]"
          style={{
            height: 26,
            padding: "0 8px",
            borderRadius: 6,
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          {open ? (
            <ChevronDown size={11} strokeWidth={2} />
          ) : (
            <ChevronRight size={11} strokeWidth={2} />
          )}
          <span>{open ? "Hide diff" : "Show diff"}</span>
          <span
            className="text-[11px]"
            style={{ fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}
          >
            · {lineCount} lines
          </span>
        </button>

        <div
          className="flex items-center gap-3 pl-3 shrink-0"
          style={{ borderLeft: "1px solid var(--border)", height: 24 }}
        >
          <span
            className="text-[11.5px]"
            style={{ fontFamily: "var(--font-mono)", color: "var(--added)" }}
          >
            +{parsed.added}
          </span>
          <span
            className="text-[11.5px]"
            style={{ fontFamily: "var(--font-mono)", color: "var(--removed)" }}
          >
            −{parsed.removed}
          </span>
        </div>

        <button
          type="button"
          onClick={onCopySha}
          data-testid="diff-card-sha"
          title="Copy diff hash"
          className="inline-flex items-center gap-1 pl-2 transition-colors"
          style={{
            color: "var(--text-faint)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
          }}
        >
          <span>{copied ? "copied" : shaShort}</span>
          <Copy size={10} strokeWidth={1.6} />
        </button>
      </div>

      {open ? (
        <div style={{ borderTop: "1px solid var(--border)" }}>
          <div
            className="text-[12.5px] leading-[1.65]"
            style={{
              fontFamily: "var(--font-mono)",
              background: "rgba(0,0,0,0.18)",
            }}
            data-testid="diff-card-body"
          >
            {renderableLines.map((line, i) => (
              <DiffRow key={i} line={line} />
            ))}
          </div>
          <div
            className="px-3.5 py-2 text-[11px]"
            style={{
              color: "var(--text-faint)",
              borderTop: "1px solid var(--border)",
            }}
          >
            {lineCount} lines changed across 1 file{" "}
            <span style={{ color: "var(--text-faint)" }}>·</span>{" "}
            review locally before applying
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const bg =
    line.kind === "add"
      ? "rgba(143,185,150,0.07)"
      : line.kind === "rm"
        ? "rgba(201,125,125,0.07)"
        : "transparent";
  const sign = line.kind === "add" ? "+" : line.kind === "rm" ? "−" : line.kind === "hunk" ? "⋯" : " ";
  const signColor =
    line.kind === "add"
      ? "var(--added)"
      : line.kind === "rm"
        ? "var(--removed)"
        : "var(--text-faint)";
  const codeColor =
    line.kind === "add"
      ? "#CFE3D3"
      : line.kind === "rm"
        ? "#E5C0C0"
        : line.kind === "hunk"
          ? "var(--text-faint)"
          : "var(--text-muted)";

  return (
    <div
      className="grid items-baseline"
      style={{
        gridTemplateColumns: "44px 14px 1fr",
        background: bg,
      }}
    >
      <div
        className="text-right pr-2.5 select-none"
        style={{ color: "var(--text-faint)", fontSize: 11 }}
      >
        {line.newLine ?? ""}
      </div>
      <div
        className="text-center select-none"
        style={{ color: signColor }}
      >
        {sign}
      </div>
      <div
        className="pr-3 whitespace-pre"
        style={{ color: codeColor }}
      >
        {syntaxTint(line.text, line.kind)}
      </div>
    </div>
  );
}

/**
 * Lightweight TypeScript-flavoured tinting. Not a real lexer — just a
 * regex pass that recognises keywords / strings / numbers / comments
 * and wraps them in the syntax tokens defined in globals.css. Cheap
 * enough for streaming, good enough for the UX.
 */
function syntaxTint(text: string, kind: DiffLine["kind"]): React.ReactNode {
  if (kind === "hunk" || kind === "meta") return text;

  // Comment line — early out for /* */, //, # anywhere.
  const commentMatch = /^(\s*)(\/\/.*|\/\*.*?\*\/|#.*)$/.exec(text);
  if (commentMatch) {
    return (
      <>
        {commentMatch[1]}
        <span style={{ color: "var(--syn-cmt)", fontStyle: "italic" }}>
          {commentMatch[2]}
        </span>
      </>
    );
  }

  // Tokenise via split. The regex captures tokens we want to highlight;
  // everything else falls through as plain text.
  const KW = /\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|export|import|from|as|class|extends|implements|interface|type|new|null|undefined|true|false|typeof|instanceof|async|await|throw|try|catch|finally|in|of|void|this|super|static|public|private|protected|readonly|enum|default|do)\b/g;
  const STR = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g;
  const NUM = /\b\d+(?:\.\d+)?\b/g;
  const FN = /\b([a-zA-Z_$][\w$]*)(?=\()/g;

  // Apply in order: strings → comments inline → numbers → keywords →
  // function calls. We do this with a single token stream pass.
  type Tok = { kind: "str" | "num" | "kw" | "fn" | "txt"; value: string };
  const tokens: Tok[] = [];
  // We use a placeholder-replace approach to avoid double-processing.
  const placeholders: { id: string; tok: Tok }[] = [];
  let working = text;
  let pid = 0;

  function replaceWithPlaceholders(re: RegExp, kind: Tok["kind"]) {
    working = working.replace(re, (m) => {
      const id = ` P${pid++} `;
      placeholders.push({ id, tok: { kind, value: m } });
      return id;
    });
  }

  replaceWithPlaceholders(STR, "str");
  replaceWithPlaceholders(NUM, "num");
  replaceWithPlaceholders(KW, "kw");
  replaceWithPlaceholders(FN, "fn");

  // Walk `working` and emit tokens.
  const parts = working.split(/( P\d+ )/g);
  for (const part of parts) {
    if (!part) continue;
    const ph = placeholders.find((p) => p.id === part);
    if (ph) tokens.push(ph.tok);
    else tokens.push({ kind: "txt", value: part });
  }

  return tokens.map((t, i) => {
    if (t.kind === "txt") return <span key={i}>{t.value}</span>;
    const color =
      t.kind === "kw"
        ? "var(--syn-kw)"
        : t.kind === "fn"
          ? "var(--syn-fn)"
          : t.kind === "str"
            ? "var(--syn-str)"
            : t.kind === "num"
              ? "var(--syn-num)"
              : "currentColor";
    return (
      <span key={i} style={{ color }}>
        {t.value}
      </span>
    );
  });
}
