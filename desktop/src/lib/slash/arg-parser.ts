/**
 * Slash-argument parser — detects when the input is positioned mid-way
 * through an enum-typed flag value (e.g. `/projects --integration=cap`)
 * so the autocomplete dropdown can surface the manifest's declared
 * `enumValues` as a deterministic third mode.
 *
 * Deterministic by design — never calls the LLM. The manifest already
 * declares the closed set of valid values for each `type: "enum"` arg;
 * we just filter and present.
 *
 * Activation rule: cursor must be at the END of the input AND immediately
 * following a `--<flag>=<partial>` token. If the user moves the cursor
 * mid-value (Home, arrow keys, click) the dropdown closes — they can
 * retype to re-enter the editing context. Keeps the parser stateless and
 * the replacement unambiguous: pick = replace `partial` with chosen value.
 */

import { findManifestEntry, type SlashArg } from "./manifest";

/**
 * Result of `parseEnumContext` — the user is editing the value of an
 * enum-typed flag. The dropdown filters `arg.enumValues` by `partial`
 * and on pick splices the chosen value into `inputValue[valueStart..]`.
 */
export interface EnumEditContext {
  /** The manifest arg whose value the user is editing. */
  arg: SlashArg;
  /**
   * The substring already typed for this value, lowercased for
   * case-insensitive filtering. Empty when the user just typed the
   * `=` and the dropdown should show every option.
   */
  partial: string;
  /**
   * Index in the original input where the partial begins (immediately
   * after the `=`). Used to splice on pick.
   */
  valueStart: number;
  /**
   * Index in the original input where the partial ends. Always equal
   * to `input.length` for the v1 "cursor at end" gate, but kept as a
   * field so a future "cursor mid-value" extension doesn't require
   * touching every call site.
   */
  valueEnd: number;
}

/**
 * Detect whether `input` ends inside a `--<flag>=<partial>` token whose
 * flag corresponds to an enum-typed arg in the active command's
 * manifest entry. Returns `null` for every other shape (no command, no
 * flag, unknown flag, non-enum arg).
 *
 * The parser is deliberately tight: only activates at the END of input.
 * Reading the cursor would require threading `selectionStart` through
 * every caller, and the practical UX is "type up to the end → see
 * options". Backspacing past the `=` closes the dropdown naturally.
 */
export function parseEnumContext(input: string): EnumEditContext | null {
  if (!input.startsWith("/")) return null;

  // Command must be followed by at least one whitespace — the user is
  // typing args. Without args there's no flag to match against.
  const firstSpaceMatch = input.match(/^(\/\S+)(\s)/);
  if (!firstSpaceMatch) return null;
  const commandName = firstSpaceMatch[1];

  const entry = findManifestEntry(commandName);
  if (!entry) return null;

  // Find the trailing `--<flag>=<partial>` token. The regex anchors to
  // the end of the string and requires a whitespace separator (or
  // start-of-string after the command) before the `--`. `\S*` matches
  // the partial value — empty is fine (user just typed `=`).
  const flagMatch = input.match(/(?:\s)--([a-z][a-z0-9_-]*)=(\S*)$/i);
  if (!flagMatch) return null;
  const flagName = flagMatch[1].toLowerCase();
  const partial = flagMatch[2];

  // Match flag name against the manifest. `arg.flag` is set on every
  // flag-style arg; positional args (no `flag` field) don't apply here.
  const arg = entry.args.find(
    (a) =>
      a.type === "enum" &&
      (a.flag ?? "").toLowerCase() === flagName &&
      Array.isArray(a.enumValues) &&
      a.enumValues.length > 0,
  );
  if (!arg) return null;

  const valueEnd = input.length;
  const valueStart = valueEnd - partial.length;
  return {
    arg,
    partial: partial.toLowerCase(),
    valueStart,
    valueEnd,
  };
}

/**
 * Filter the context's enum values by the typed partial. Case-
 * insensitive `includes` (not just prefix) so `cap` finds `capture`
 * mid-list — matches Slack/Linear/VSCode command-palette behavior.
 *
 * Pure function; exported so the component renders the same filtered
 * list the parent computes for the row count check.
 */
export function filterEnumValues(
  context: EnumEditContext,
): readonly string[] {
  const values = context.arg.enumValues ?? [];
  if (!context.partial) return values;
  return values.filter((v) => v.toLowerCase().includes(context.partial));
}

/**
 * Splice a picked enum value into the input, replacing the partial.
 * Returns the new input string (caller pushes it to the store).
 *
 * Always appends a trailing space so the user can immediately keep
 * typing the next arg without an explicit keystroke — matches how
 * shell autocomplete behaves after Tab.
 */
export function completeEnumValue(
  input: string,
  context: EnumEditContext,
  value: string,
): string {
  const before = input.slice(0, context.valueStart);
  const after = input.slice(context.valueEnd);
  // Trailing space immediately follows the inserted value so the user
  // can keep typing the next arg without an extra keystroke. Placing
  // the space here (vs at the very end) also keeps the splice well-
  // defined for the cursor-mid-value extension flagged in
  // `parseEnumContext`'s docstring.
  return `${before}${value} ${after}`;
}
