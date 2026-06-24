/**
 * Slash-command autocomplete dropdown. Floats above the chat input in
 * three distinct modes:
 *
 *  - **deterministic** (`matches`): user typed `/<prefix>` → show every
 *    catalog entry whose name starts with the prefix. NO AI call,
 *    instant. Existing Phase 1 behavior.
 *  - **AI** (`suggestions`): user typed non-slash text → debounced
 *    `suggest_slash_commands` IPC returns top-3 ranked completions
 *    (Phase 2 of the pure-slash refactor). Rows include the AI's
 *    rationale and render the FULL command (with args) so Enter
 *    replaces the input verbatim.
 *  - **arg-enum** (`enumOptions`): user typed `/cmd --flag=` for a flag
 *    whose manifest arg is `type: "enum"` → show the closed set of
 *    valid values (Phase 4.1 of the pure-slash refactor). Deterministic
 *    — never calls the LLM. Filtered case-insensitively by the partial
 *    value the user has typed after the `=`.
 *
 * Mode priority (parent guarantees only one is non-empty at a time, but
 * the component is defensive and resolves ties in this order):
 *
 *   - matches.length > 0       → deterministic slash dropdown
 *   - suggestions.length > 0   → AI ranked suggestions
 *   - enumOptions.length > 0   → enum value dropdown
 *   - aiEmpty && !aiLoading    → AI mode placeholder ("No command matches")
 *   - otherwise                → render null
 *
 * Visual continuity: every mode shares `.palette-row[data-selected]`
 * from `globals.css` so the cream-stripe + cream-tint highlight matches
 * the CommandPalette surface. AI suggestions get a tiny "AI" chip on
 * the label so users register that the row is model-generated.
 *
 * Why the AI mode displays the full command (not just the name): the
 * model fills in concrete args. Showing the result verbatim sets
 * expectations — the user sees `/projects --integration=capture` in
 * the dropdown and the same string lands in the input on Enter.
 */

import {
  ArrowUpRight,
  Database,
  Search,
  Settings2,
  Zap,
  type LucideIcon,
} from "lucide-react";

import type { SlashDisplayEntry } from "@/lib/slash-catalog";
import { categoryOf, type SlashCategory } from "@/lib/slash/manifest";
import type { SlashSuggestion } from "@/lib/slash/suggest-ipc";

// Re-export for callers that import the type alongside the component
// to keep the dependency surface one symbol away. The IPC module is
// the canonical home for the type — this is just a convenience.
export type { SlashSuggestion } from "@/lib/slash/suggest-ipc";

/**
 * Phase 4.5 — per-row icon mapping. The four manifest categories get
 * a distinct lucide-react glyph; rows without a category get the
 * neutral Search icon. Kept as a single switch so a future category
 * addition (e.g. `voice`, `dev`) is a one-line change.
 */
function iconForCategory(category: SlashCategory | undefined): LucideIcon {
  switch (category) {
    case "query":  return Database;
    case "action": return Zap;
    case "nav":    return ArrowUpRight;
    case "meta":   return Settings2;
    default:       return Search;
  }
}

/**
 * Render a label with the matched substring bolded. Used by the
 * deterministic slash dropdown (matches input prefix) and the
 * enum-value dropdown (matches input partial). Returns the original
 * label unchanged when `query` is empty OR doesn't match anywhere —
 * keeps rendering deterministic for snapshot-style assertions.
 *
 * Matching is case-insensitive against the visible label but the
 * rendered substring preserves the label's original casing so the
 * highlighter never visually rewrites the label.
 */
function HighlightedLabel({
  text,
  query,
}: {
  text:  string;
  query: string;
}) {
  if (!query) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span
        style={{
          fontWeight: 600,
          color: "var(--accent)",
        }}
      >
        {text.slice(idx, idx + query.length)}
      </span>
      {text.slice(idx + query.length)}
    </>
  );
}

export interface SlashAutocompleteProps {
  /**
   * Deterministic matches — populated when the input starts with `/`.
   * Empty in AI mode. The two arrays are mutually exclusive by parent
   * convention; this component picks deterministic first when both
   * happen to be non-empty (defensive — should not occur in practice).
   */
  matches: readonly SlashDisplayEntry[];
  /**
   * AI suggestions — populated when the input is non-slash text and
   * the `suggest_slash_commands` IPC has returned. Empty in
   * deterministic mode AND while loading (loading shows nothing
   * rather than a stale list to avoid a flicker on each keystroke).
   */
  suggestions?: readonly SlashSuggestion[];
  /**
   * True when an AI request is in flight. Used to suppress the
   * "no command matches" placeholder during the loading window — we
   * don't want it to flash for ~300ms after every keystroke.
   */
  aiLoading?: boolean;
  /**
   * True when an AI request has completed and returned zero
   * suggestions. Renders the "No command matches" hint row. Reset by
   * the parent on every new keystroke (otherwise the hint sticks
   * after the user starts typing a slash).
   */
  aiEmpty?: boolean;
  /**
   * Enum values to render when the user is editing a `--flag=` whose
   * manifest arg is `type: "enum"` (Phase 4.1). Parent computes via
   * `parseEnumContext` + `filterEnumValues`. Empty in the other two
   * modes. Picking a row splices the value into the input.
   */
  enumOptions?: readonly string[];
  /**
   * Optional label shown above the enum dropdown — typically the
   * flag name (e.g. "integration"). Helps the user place what set of
   * values they're picking from. Omitted = no header row.
   */
  enumHeader?: string;
  /**
   * Substring to bold in each row's label (Phase 4.5). Used by the
   * deterministic + enum modes to surface "which characters matched
   * what you typed". Empty / omitted → no highlight. AI mode passes
   * the empty string (suggestions are model-generated and don't
   * literally contain the user query).
   */
  highlightQuery?: string;
  /** Index of the currently highlighted match (0-based). Clamped externally. */
  selectedIdx: number;
  /** Click / Enter handler — receives the row index, parent completes the input. */
  onSelect: (idx: number) => void;
}

const CONTAINER_STYLE: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: "calc(100% + 8px)",
  zIndex: 60,
  maxHeight: 280,
  overflowY: "auto",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  boxShadow:
    "0 12px 32px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.25)",
  padding: 4,
};

export function SlashAutocomplete({
  matches,
  suggestions = [],
  aiLoading = false,
  aiEmpty = false,
  enumOptions = [],
  enumHeader,
  highlightQuery = "",
  selectedIdx,
  onSelect,
}: SlashAutocompleteProps) {
  // Deterministic mode wins when both arrays happen to be non-empty.
  // In practice DockConversation never feeds both simultaneously
  // (one is always [] based on the input prefix), but the priority
  // keeps the component decisive if a caller drifts.
  if (matches.length > 0) {
    return (
      <SlashList
        rows={matches.map((entry) => ({
          // Stable id pattern preserved from Phase 1 — DockConversation's
          // `aria-activedescendant` and Phase 1 tests both target
          // `slash-suggestion-<command>`.
          key:      entry.command,
          id:       `slash-suggestion-${entry.command}`,
          label:    `/${entry.command}`,
          helper:   entry.description,
          tone:     entry.tone,
          testId:   `slash-suggestion-${entry.command}`,
          aiBadge:  false,
          // Phase 4.5 — pick an icon from the manifest's category for
          // this command. Falls back to the neutral Search icon when
          // the entry isn't in the manifest (e.g. catalog-only display
          // entries that haven't been migrated yet).
          category: categoryOf(entry.command),
        }))}
        highlightQuery={highlightQuery}
        selectedIdx={selectedIdx}
        onSelect={onSelect}
        showFooter
      />
    );
  }

  if (suggestions.length > 0) {
    return (
      <SlashList
        rows={suggestions.map((s, idx) => ({
          // Suggestions are not unique-by-string (the LLM occasionally
          // ranks duplicates) — pair command with index so React stays
          // stable on re-render. The id uses index alone so the
          // parent's aria-activedescendant can target it without
          // knowing the command text.
          key:     `${idx}-${s.command}`,
          id:      `ai-suggestion-${idx}`,
          label:   s.command,
          helper:  s.rationale,
          testId:  `ai-suggestion-${idx}`,
          aiBadge: true,
          // Look up the manifest entry by the leading slash token of
          // the suggested command (e.g. `/projects` from
          // `/projects --integration=capture`).
          category: categoryOf(parseSuggestionCommandName(s.command)),
        }))}
        highlightQuery=""
        selectedIdx={selectedIdx}
        onSelect={onSelect}
        showFooter
      />
    );
  }

  // Arg-enum mode — Phase 4.1. The parent passes the filtered, ordered
  // list of valid values for the flag the user is currently editing.
  // Each row is just the value; no rationale, no AI badge.
  if (enumOptions.length > 0) {
    return (
      <SlashList
        header={enumHeader ? `${enumHeader}` : undefined}
        rows={enumOptions.map((value, idx) => ({
          key:     `enum-${idx}-${value}`,
          id:      `enum-option-${idx}`,
          label:   value,
          helper:  "",
          testId:  `enum-option-${idx}`,
          aiBadge: false,
          // Enum values are arg-value chips — neutral, no command
          // category attaches.
          category: undefined,
        }))}
        highlightQuery={highlightQuery}
        selectedIdx={selectedIdx}
        onSelect={onSelect}
        showFooter
      />
    );
  }

  // AI mode finished with zero suggestions → show a hint row. We
  // suppress it while the request is still in flight so the user
  // doesn't see "no match" flash on every keystroke. Hidden entirely
  // in deterministic mode (parent passes aiEmpty=false there).
  if (aiEmpty && !aiLoading) {
    return (
      <div
        id="slash-autocomplete"
        role="status"
        aria-live="polite"
        data-testid="ai-suggestion-empty"
        style={CONTAINER_STYLE}
      >
        <div
          className="palette-row"
          style={{
            cursor: "default",
            // Faint — this is a hint, not a selectable row.
            color: "var(--text-faint)",
            fontSize: 12.5,
            padding: "8px 10px",
          }}
        >
          No command matches. Type{" "}
          <code style={{ color: "var(--text-subtle)" }}>/help</code> to see
          what&apos;s available.
        </div>
      </div>
    );
  }

  return null;
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Pick the leading slash token off an AI-suggested command line so the
 * dropdown can look up its category. Returns the empty string when the
 * suggestion doesn't start with `/<word>` — the manifest lookup falls
 * through to the neutral icon there.
 */
function parseSuggestionCommandName(line: string): string {
  const match = line.match(/^(\/\S+)/);
  return match?.[1] ?? "";
}

interface SlashListRow {
  key:       string;
  id:        string;
  label:     string;
  helper:    string;
  tone?:     string;
  testId:    string;
  aiBadge:   boolean;
  /**
   * Manifest category for this row — drives the leading icon. May be
   * undefined for catalog-only entries or for the enum-value rows
   * (which fall through to the neutral Search icon).
   */
  category?: SlashCategory;
}

interface SlashListProps {
  rows:           SlashListRow[];
  selectedIdx:    number;
  onSelect:       (idx: number) => void;
  /**
   * Substring to bold inside each row's label. Phase 4.5 — slash and
   * enum modes pass the user's typed prefix; AI mode passes the
   * empty string so model-generated commands aren't highlighted
   * against unrelated user text.
   */
  highlightQuery?: string;
  /**
   * Optional header rendered above the rows — used by the arg-enum
   * mode to label which flag is being edited (e.g. "integration").
   * Omitted = no header. Non-selectable; pure context for the user.
   */
  header?:        string;
  /**
   * When true, render the keyboard-hint footer ("↑↓ navigate · enter
   * pick · esc dismiss"). Hidden in modes that don't expose keyboard
   * navigation — currently always-on for the three live modes.
   */
  showFooter?:    boolean;
}

function SlashList({
  rows,
  selectedIdx,
  onSelect,
  highlightQuery = "",
  header,
  showFooter = false,
}: SlashListProps) {
  return (
    <div
      id="slash-autocomplete"
      role="listbox"
      aria-label="Slash command suggestions"
      data-testid="slash-autocomplete"
      style={CONTAINER_STYLE}
    >
      {header ? (
        <div
          data-testid="slash-autocomplete-header"
          style={{
            padding: "6px 10px 4px",
            fontSize: 10.5,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--text-faint)",
          }}
        >
          {header}
        </div>
      ) : null}
      {rows.map((row, idx) => {
        const selected = idx === selectedIdx;
        const Icon = iconForCategory(row.category);
        return (
          <button
            key={row.key}
            id={row.id}
            type="button"
            role="option"
            aria-selected={selected}
            data-selected={selected ? "true" : "false"}
            data-testid={row.testId}
            data-category={row.category ?? "none"}
            onClick={() => onSelect(idx)}
            // Mouse hover does NOT change `selectedIdx` — keyboard
            // is the source of truth so the highlight doesn't jump
            // when the cursor accidentally drifts. Clicking still
            // completes via `onSelect`.
            onMouseDown={(e) => e.preventDefault()}
            // `palette-row` is defined in `globals.css`; pairing with
            // `data-selected` paints the cream stripe + tint that the
            // CommandPalette uses, so the two surfaces feel related.
            className="palette-row"
            style={{
              width: "100%",
              textAlign: "left",
              border: "none",
              cursor: "pointer",
            }}
          >
            {/* Phase 4.5 — leading icon. Subtle, monochrome; the
             *  `palette-row` style supplies the row's own padding so we
             *  only need to align the icon vertically with the label. */}
            <span
              aria-hidden
              data-testid={`row-icon-${row.category ?? "none"}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                color: "var(--text-faint)",
                marginRight: 2,
              }}
            >
              <Icon size={13} strokeWidth={1.6} />
            </span>
            <span
              className="palette-row__label"
              style={{
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
                fontSize: 13,
                // Brand tone when present. Falls back to default text
                // color so toneless / AI entries (utility commands,
                // model-generated suggestions) stay visually neutral.
                color: row.tone ?? "var(--text)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span data-testid={`row-label-${row.testId}`}>
                <HighlightedLabel text={row.label} query={highlightQuery} />
              </span>
              {row.aiBadge ? (
                <span
                  aria-label="AI suggestion"
                  data-testid="ai-suggestion-badge"
                  style={{
                    fontSize: 9.5,
                    fontFamily:
                      "var(--font-sans, -apple-system, system-ui, sans-serif)",
                    fontWeight: 600,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    color: "var(--text-faint)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    padding: "1px 4px",
                  }}
                >
                  AI
                </span>
              ) : null}
            </span>
            <span
              className="palette-row__helper"
              style={{
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
              }}
            >
              {row.helper}
            </span>
          </button>
        );
      })}
      {showFooter ? (
        <div
          data-testid="slash-autocomplete-footer"
          style={{
            display: "flex",
            justifyContent: "flex-end",
            padding: "6px 10px 4px",
            fontSize: 10,
            letterSpacing: "0.04em",
            color: "var(--text-faint)",
            borderTop: "1px solid var(--border)",
            marginTop: 2,
          }}
        >
          ↑↓ navigate · enter pick · esc dismiss
        </div>
      ) : null}
    </div>
  );
}

/**
 * Filter the display list by the typed input. Returns matches whose
 * `command` starts with the prefix after `/`. Returns the full list
 * for the bare `/` (so the user sees everything they could type next).
 *
 * Pure function — exposed so DockConversation + tests can compute the
 * same matches the dropdown will display.
 */
export function filterSlashMatches(
  inputValue: string,
  source: readonly SlashDisplayEntry[],
): readonly SlashDisplayEntry[] {
  if (!inputValue.startsWith("/")) return [];
  const after = inputValue.slice(1).toLowerCase();
  // Don't filter past the first whitespace — once the user starts
  // typing args, the autocomplete has done its job and should hide.
  if (after.includes(" ") || after.includes("\t")) return [];
  if (after === "") return source;
  return source.filter((e) => e.command.startsWith(after));
}
