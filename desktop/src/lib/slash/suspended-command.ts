/**
 * Inari Live Phase 5 — SuspendedCommand protocol.
 *
 * When a slash command detects a missing required arg OR a missing
 * prerequisite, it returns a structured "I need X" result instead of
 * refusing with an error. The dock surface renders a specialized
 * picker for that slot; on selection, the dispatcher resumes the
 * command with the merged args.
 *
 * Designed to coexist with the existing handler signature: legacy
 * handlers that return Promise<void> keep working unchanged. Only the
 * 4 pilot commands (Phase 5.5–5.8) opt into suspending; the rest stay
 * on the old "push an error note" path until Phase 6 picks them up.
 *
 * ## Architectural invariants (per `INARI_LIVE_PHASE_5_PLAN.md`)
 *
 * 1. Pickers are deterministic React components — no LLM call to pick
 *    an entity.
 * 2. Each suspend → pick → resume cycle handles ONE slot at a time.
 *    A command that needs N slots returns N suspends sequentially.
 * 3. Cancel returns the dock to idle. No half-filled commands left in
 *    the input.
 * 4. Every successful resume reduces to ONE deterministic slash
 *    dispatch — the LLM never executes anything.
 */
import type { ChatMessage } from "../store/chat";

// ── Slot kinds + spec ──────────────────────────────────────────────────────

/**
 * What kind of value the dock is collecting. Drives the picker
 * component selection in `SlotPicker`. Adding a kind: define a new
 * specialized picker, then map it inside `SlotPicker`'s switch.
 *
 * - `contact` — paired messenger recipient (WhatsApp display name +
 *   jid). Used by `/whatsapp`, `/telegram`, `/slack` once they opt in.
 * - `project` — a cloud project (id + name + optional local path).
 *   Used by `/health`, future `/uptime <project>`.
 * - `alert` — a recent alert (id + hash + title). Used by `/fix`,
 *   future `/alert`, `/silence`, `/ack`.
 * - `path` — absolute filesystem path. Used by `/install`, future
 *   `/test`.
 * - `text` — multi-line freeform string (message body, resolution
 *   summary). Used by `/whatsapp <recipient> ?`, future `/resolve`.
 * - `project_link` — bridge to the AddProjectWizard for the
 *   project-linking flow. Distinct from `project` (which picks from
 *   already-linked projects); this kind kicks off / surfaces the
 *   wizard that links a brand-new project to a local clone path.
 *   `SlotSpec.optionsHint.path` carries the path to pre-fill.
 */
export type SlotKind =
  | "contact"
  | "project"
  | "alert"
  | "path"
  | "text"
  | "project_link";

/**
 * What a suspended command is asking for. The picker UI shows
 * `prompt` in its header and routes by `kind` to the specialized
 * component. `optionsHint` is a free-form bag that lets a handler
 * narrow the picker — e.g. "only show alerts for project X" or
 * "default to multiline".
 */
export interface SlotSpec {
  kind: SlotKind;
  /** Slot identifier — the arg name this fills (e.g. "recipient"). */
  name: string;
  /**
   * One-line header label, e.g. "who?" / "which project?" /
   * "message body". Should fit on one line at 14px.
   */
  prompt: string;
  /** Optional placeholder for the picker's search/input box. */
  placeholder?: string;
  /**
   * Provider-specific filter / hint. The picker reads what it needs
   * and ignores the rest. Kept loose so adding a new filter doesn't
   * propagate through the dispatcher.
   *
   * Examples:
   *   `{ severity: "critical" }`  — `alert` picker pre-filters.
   *   `{ multiline: true }`       — `text` picker grows to textarea.
   *   `{ projectId: "abc-…" }`    — alerts scoped to one project.
   */
  optionsHint?: Record<string, unknown>;
}

// ── Partial command (resume state) ─────────────────────────────────────────

/**
 * The state a suspended command carries forward so the dispatcher can
 * resume it once the slot is filled. Kept narrow: command name + the
 * typed args we've collected so far + the raw rest-of-input the user
 * originally typed (for display in the picker header).
 */
export interface PartialCommand {
  /** Command name WITHOUT leading `/`, e.g. `"whatsapp"`. */
  command: string;
  /**
   * Args already collected — typed values keyed by manifest arg name.
   * For `/whatsapp Jose`, after the contact picker resolves Jose,
   * this is `{ recipient: "+5215..." }` and the next suspend asks
   * for the message body.
   */
  collectedArgs: Record<string, unknown>;
  /**
   * The raw args string the user originally typed. Lets the picker
   * show "/whatsapp Jose → message?" rather than just "/whatsapp".
   * Empty when no args were typed.
   */
  rawArgs: string;
}

// ── Slot value (picker → resume) ───────────────────────────────────────────

/**
 * What a specialized picker returns when the user picks an entity.
 * The dispatcher uses `kind` to narrow and merge the typed value into
 * `PartialCommand.collectedArgs`. Each variant is the minimum data a
 * handler needs to continue: pickers may carry richer entities
 * internally, but they collapse to these shapes at the boundary.
 */
export type SlotValue =
  | { kind: "contact"; jid: string; name: string }
  | { kind: "project"; id: string; name: string; path?: string }
  | { kind: "alert"; id: string; hash: string; title: string }
  | { kind: "path"; value: string }
  | { kind: "text"; value: string }
  // The wizard's payload carries `projectId` (and optionally name).
  // The slot resolves to that pair so the resumed `/install`
  // serialises with `--project=<id>`.
  | { kind: "project_link"; projectId: string; name?: string };

// ── Command result (handler → dispatcher) ──────────────────────────────────

/**
 * Per-command rebuilder — turns merged args back into a canonical
 * `/cmd <args>` string the dispatcher can re-parse. Owned by each
 * pilot handler so the dispatcher stays agnostic to arg shape
 * (positional vs flag, quoting, encoding).
 *
 * Example for `/whatsapp <recipient> <message>`:
 *   (args) => `/whatsapp ${args.recipient_display ?? args.recipient} ${args.message}`
 */
export type Rebuild = (mergedArgs: Record<string, unknown>) => string;

/**
 * The inside of a `{kind: "suspended", ...}` CommandResult, bundled
 * for ergonomics: the dock surface stashes the whole bag in component
 * state and passes only what each layer needs (spec + partial to the
 * `<SlotPicker>`, rebuild to `resumeSlashCommand`).
 */
export interface SuspendedState {
  /** What the picker should ask for. */
  needs: SlotSpec;
  /** Command + args collected so far. */
  partial: PartialCommand;
  /**
   * Per-command serializer. The dock surface calls this with the
   * merged args (after `mergeSlotValue`) and feeds the result back
   * into the dispatcher.
   */
  rebuild: Rebuild;
}

/**
 * Discriminated union returned by a suspend-aware handler.
 *
 * - `ok` — command ran to completion. Handler already pushed its
 *   output messages via `appendMessage`. Dispatcher does nothing else.
 * - `error` — command failed for non-recoverable reasons. Handler
 *   already pushed an error note. Dispatcher does nothing else.
 * - `suspended` — command needs more input. The dispatcher hands the
 *   `SuspendedState` to the dock surface, which renders a picker.
 *   On pick, `resumeSlashCommand` re-runs the handler with the merged
 *   args via `rebuild`.
 *
 * Why ok/error distinct from suspended: legacy handlers do their own
 * appendMessage and return void; suspend-aware handlers add the third
 * branch without changing the legacy callers' behavior.
 */
export type CommandResult =
  | { kind: "ok" }
  | { kind: "error" }
  | ({ kind: "suspended" } & SuspendedState);

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Concise `{kind: "suspended", …}` constructor. Reads better at call
 * sites than building the literal:
 *
 *   if (!recipient) {
 *     return suspend({
 *       command: "whatsapp",
 *       needs:   { kind: "contact", name: "recipient", prompt: "who?" },
 *       rebuild: (args) => `/whatsapp ${args.recipient} ${args.message ?? ""}`,
 *       rawArgs,
 *     });
 *   }
 *
 * `rebuild` defaults to a positional concatenation when not provided —
 * suitable for commands whose args are simple positional strings.
 */
export interface SuspendArgs {
  command: string;
  needs: SlotSpec;
  rawArgs?: string;
  collectedArgs?: Record<string, unknown>;
  rebuild?: Rebuild;
}

export function suspend(args: SuspendArgs): CommandResult {
  return {
    kind: "suspended",
    needs: args.needs,
    partial: {
      command: args.command,
      collectedArgs: args.collectedArgs ?? {},
      rawArgs: args.rawArgs ?? "",
    },
    rebuild: args.rebuild ?? defaultPositionalRebuild(args.command),
  };
}

/**
 * Fallback rebuilder — concatenates collected args as positional
 * tokens in object-iteration order, filtering out the `_display` /
 * `_hash` / `_path` companion keys. Sufficient for simple commands
 * (`/install <path>`, `/health <project_id>`); commands with flags or
 * non-trivial serialization should provide their own `rebuild`.
 */
function defaultPositionalRebuild(command: string): Rebuild {
  return (args) => {
    const tokens: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (
        key.endsWith("_display") ||
        key.endsWith("_hash") ||
        key.endsWith("_path")
      ) {
        continue;
      }
      if (value === null || value === undefined) continue;
      tokens.push(String(value));
    }
    return tokens.length > 0
      ? `/${command} ${tokens.join(" ")}`
      : `/${command}`;
  };
}

/**
 * Merge a picked `SlotValue` into the `PartialCommand` and return the
 * new collectedArgs map. The dispatcher then re-invokes the handler
 * with these args; if more slots are missing the handler returns
 * another `suspended`, otherwise it runs.
 *
 * Why per-kind expansion: a contact picker yields BOTH the typed
 * recipient (for the wire call) and a display name (for the user-facing
 * echo). Pickers that only carry one value (path, text) collapse to
 * `{ [name]: value }`.
 */
export function mergeSlotValue(
  partial: PartialCommand,
  slotName: string,
  value: SlotValue,
): Record<string, unknown> {
  const next = { ...partial.collectedArgs };
  switch (value.kind) {
    case "contact":
      next[slotName] = value.jid;
      next[`${slotName}_display`] = value.name;
      return next;
    case "project":
      next[slotName] = value.id;
      next[`${slotName}_display`] = value.name;
      if (value.path !== undefined) {
        next[`${slotName}_path`] = value.path;
      }
      return next;
    case "alert":
      next[slotName] = value.id;
      next[`${slotName}_hash`] = value.hash;
      next[`${slotName}_display`] = value.title;
      return next;
    case "path":
    case "text":
      next[slotName] = value.value;
      return next;
    case "project_link":
      // Distinct from `project` (which lifts id + name): the wizard-
      // backed flow yields `projectId` as the canonical wire value;
      // name is best-effort metadata for the header / display.
      next[slotName] = value.projectId;
      if (value.name !== undefined) {
        next[`${slotName}_display`] = value.name;
      }
      return next;
  }
}

/**
 * Build a one-line display string from `partial.collectedArgs` for the
 * picker header. Uses `*_display` keys when available, falls back to
 * the raw value otherwise. Truncates long values so the header stays
 * on one line.
 *
 * E.g. after the contact picker resolves Jose, this renders "Jose"
 * (from `recipient_display`), not "+5215512345678".
 */
export function describeCollected(partial: PartialCommand): string {
  const entries = Object.entries(partial.collectedArgs).filter(
    ([k]) => !k.endsWith("_display") && !k.endsWith("_hash") && !k.endsWith("_path"),
  );
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      const display = partial.collectedArgs[`${k}_display`];
      const value =
        typeof display === "string"
          ? display
          : typeof v === "string"
            ? v
            : JSON.stringify(v);
      return value.length > 40 ? `${value.slice(0, 39)}…` : value;
    })
    .join(" ");
}

// ── Dispatcher hook (consumed by slash-dispatch + DockConversation) ────────

/**
 * Callback the dispatcher uses to surface a `suspended` state to the
 * dock UI. The chat surface implements this to:
 *   1. Stash the SuspendedState in component state.
 *   2. Render `<SlotPicker>` below the input bar.
 *   3. On pick, call `resumeSlashCommand` with the merged args +
 *      the `rebuild` from the suspended state.
 *   4. On cancel, drop the state + return to idle input.
 *
 * Why an optional ctx field instead of a return value: legacy handlers
 * don't need it. Only the suspend-aware pilots (5.5–5.8) call into it,
 * via the `onSuspended` field on `SlashCtx`.
 */
export type SuspendedHandler = (state: SuspendedState) => void;

/**
 * Tiny no-op default — when no chat surface is wired (e.g. headless
 * tests that don't care about the slot UI), suspended commands still
 * resolve cleanly: the handler pushes a single fallback note and
 * returns `error`, matching the pre-Phase-5 behavior.
 *
 * Returned from `slash-dispatch.ts` when `ctx.onSuspended` is unset so
 * pilot handlers can call into `ctx.onSuspended` unconditionally.
 */
export const NOOP_SUSPENDED: SuspendedHandler = () => {
  /* nothing */
};

// ── Test-only fixtures ─────────────────────────────────────────────────────

/**
 * Build a `ChatMessage` for a suspended-state echo. Useful for
 * dispatcher unit tests that want to verify the user-facing echo
 * happened even when the command suspended.
 *
 * Not exported as part of the public API — the dispatcher rolls its
 * own makeUserMessage/makeAssistantNote for production callers. Lives
 * here so the test suite has a shared fixture without reaching into
 * private dispatcher internals.
 */
export function makeSuspendedEchoForTest(
  command: string,
  rawArgs: string,
): ChatMessage {
  const content = rawArgs ? `/${command} ${rawArgs}` : `/${command}`;
  return {
    id: `slash_user_suspended_${command}_${Date.now()}`,
    role: "user",
    content,
    createdAt: Date.now(),
  };
}
