/**
 * Slash-command dispatcher. End-to-end orchestration: parse → catalog
 * lookup → arg conversion → IPC → push chat messages.
 *
 * Designed to be called from the chat input handler with a 5-line
 * wiring pattern:
 *
 *   if (handleSlashSubmit(inputValue, slashCtx)) {
 *     setInputValue("");
 *     return; // skip sendMessage — slash handled the turn
 *   }
 *   sendMessage(inputValue);
 *
 * Dependency injection (the `SlashCtx` `invoke` field) keeps the
 * dispatcher testable without spinning up Tauri / DOM. Production
 * callers pass `desktopToolInvokeViaSlash` from `tool-invoke-ipc.ts`;
 * tests pass an in-memory stub that returns the desired
 * `InvokeOutcome` shape.
 *
 * Why a separate module instead of inlining in DockConversation:
 * - Pure dispatch logic, no React hooks → testable in isolation.
 * - DockConversation is under active redesign in parallel; isolating
 *   this lets the rewrite happen without re-engineering the dispatch.
 * - 100% of the slash logic lives behind one entry point — easy to
 *   mock in tests of any caller.
 */

import {
  githubSubpath,
  resolveActiveGitHubRepo as realResolveActiveGitHubRepo,
  type GitHubRepoResult,
} from "./github-repo";
import { parseSlashCommand, type SlashCommand } from "./slash";
import { findSlashCommand } from "./slash-catalog";
import { useChat, type ChatMessage } from "./store/chat";
import { useAppState } from "./store/useAppState";
import { useVoiceSettings } from "./store/voice";
import type { ThemeMode } from "./theme";
import { navigateTo, openMainWindow } from "./main-ipc";
import {
  desktopToolInvokeViaSlash as realDesktopToolInvokeViaSlash,
  type InvokeOutcome,
} from "./tool-invoke-ipc";
import {
  parseWhatsAppArgs,
  resolveWhatsAppRecipient as realResolveWhatsAppRecipient,
  type WhatsAppResolution,
} from "./whatsapp-recipient";
import {
  STRUCTURED_HANDLERS,
  type SlashCloudIpc,
} from "./slash/handlers";
import {
  SLASH_MANIFEST,
  type SlashCommand as ManifestCommand,
} from "./slash/manifest";
import { formatUnknownCommand } from "./slash/error-help";
import type {
  PartialCommand,
  Rebuild,
  SlotSpec,
  SuspendedHandler,
} from "./slash/suspended-command";
import type { MemoryEntry } from "./slash/scoped-memory";

export type { SlashCloudIpc } from "./slash/handlers";
export type {
  CommandResult,
  PartialCommand,
  Rebuild,
  SlotKind,
  SlotSpec,
  SlotValue,
  SuspendedHandler,
  SuspendedState,
} from "./slash/suspended-command";
export type {
  MemoryEntry,
  ResolvedEntity,
} from "./slash/scoped-memory";

/**
 * Meta-commands that are handled entirely client-side without an IPC
 * call or audit row. `/help` and `/?` both render an inline catalog
 * listing — they never touch the backend, so an audit row would be
 * misleading noise (no tool was invoked).
 */
const META_COMMANDS = new Set(["help", "?"]);

/**
 * `/github` and `/gh` are alias-pairs of a meta-command that resolves
 * the active workspace's repo, builds a github.com URL, and dispatches
 * `desktop.open_url`. They DO write an audit row (open_url ran) but
 * the resolution step ("which repo?") happens before the IPC, so we
 * special-case the command in the dispatcher rather than the catalog.
 */
const GITHUB_COMMANDS = new Set(["github", "gh"]);

/**
 * `/whatsapp` and `/wa` resolve a display-name (or raw E.164) against
 * `pairingList()` to a phone number, then dispatch
 * `comm.send_whatsapp`. Same pattern as /github — async resolve before
 * the IPC, hence a dispatcher special-case rather than a catalog entry.
 *
 * V1 ships with the same Confirm-bypass semantics as the rest of the
 * slash track (typing the recipient + message body in the chat input
 * IS the visual confirmation). If a user wants stricter behavior they
 * can flip `comm.send_whatsapp` to Deny in Settings → Permissions and
 * the slash dispatcher will surface a "set in Settings" message.
 */
const WHATSAPP_COMMANDS = new Set(["whatsapp", "wa"]);

/**
 * `/test <path>` — Inari Guard test generation. Resolves the active
 * project's slug to a cloud project id, then POSTs the file content
 * to /api/test-generation/start via the `cloud_generate_test` IPC.
 * Special-cased (vs catalog) because:
 *   1. Needs async slug→id resolution before the IPC.
 *   2. The "IPC" here is a direct HTTP call to the cloud, not a
 *      `desktop_tool_invoke_via_slash` — no Confirm/Deny lifecycle.
 */
const TEST_COMMANDS = new Set(["test"]);

/**
 * `/install <path>` — Phase 5.6 pilot. The catalog entry still
 * handles the IPC dispatch on the happy path; the dispatcher just
 * intercepts ahead of the catalog when (a) `ctx.onSuspended` is
 * wired AND (b) the path arg is missing or non-absolute. In that
 * case we hand a PathPickerSlot to the dock surface instead of
 * surfacing the error message.
 *
 * Falls through to the standard catalog flow when the args are
 * valid OR when the surface didn't wire `onSuspended` (legacy /
 * headless tests).
 */
const INSTALL_COMMANDS = new Set(["install"]);

/**
 * Same absolute-path detection the catalog uses for `/install`.
 * Duplicated here so the suspend interception can run without
 * pulling in the catalog's parseArgs (which would re-parse the
 * args we'd then re-parse downstream).
 */
function isAbsolutePathForInstall(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/");
}

/**
 * "Simple meta" commands that don't dispatch a tool — they just call
 * a store action or a navigation IPC. Each handler is a tiny wrapper
 * that produces ONE assistant note describing what happened.
 *
 * Why a registry: keeps the dispatcher's switch-tree shallow as the
 * V1 batch grows. Adding a new command is now `[name, handler]` in
 * one place + an entry in `SLASH_META`.
 */
type SimpleMetaHandler = (
  parsed: SlashCommand,
  ctx: SlashCtx,
) => Promise<void> | void;

const SIMPLE_META_HANDLERS: Record<string, SimpleMetaHandler> = {
  new:      handleNewConversation,
  clear:    handleClearConversation,
  settings: handleSettings,
  audit:    handleAudit,
  devices:  handleDevices,
  theme:    handleTheme,
  voice:    handleVoice,
  // Inari Live V1 — Session 5 conversation lifecycle handlers. Each
  // requires `ctx.conversationId` to be set; when the chat surface is
  // in dock-only mode (no server-anchored conversation), the handler
  // renders an inline note explaining that the command needs an open
  // conversation thread.
  snooze:   handleConversationSnooze,
  resolve:  handleConversationResolve,
  reopen:   handleConversationReopen,
  archive:  handleConversationArchive,
  ack:      handleConversationAck,
  silence:  handleConversationSilence,
  escalate: handleConversationEscalate,
  summarize:handleConversationSummarize,
  export:   handleConversationExport,
  witness:  handleConversationWitness,
};

/** Dependencies the dispatcher pulls from the surrounding context. */
export interface SlashCtx {
  /** Push a chat message into the conversation. */
  appendMessage: (msg: ChatMessage) => void;
  /** Current chat session id, forwarded to the IPC for audit attribution. */
  sessionId: string | null;
  /**
   * IPC dispatcher. Defaults to the real `desktopToolInvokeViaSlash`
   * exported from `tool-invoke-ipc.ts`. Tests pass an in-memory stub.
   */
  invoke?: (
    toolName: string,
    args: unknown,
    sessionId: string | null,
  ) => Promise<InvokeOutcome>;
  /**
   * Active-GitHub-repo resolver. Defaults to the real implementation
   * that walks `resolveActiveRepo + desktop_git_origin_url + parse`.
   * Tests pass a stub that returns the desired `GitHubRepoResult`.
   */
  resolveActiveGitHubRepo?: () => Promise<GitHubRepoResult>;
  /**
   * WhatsApp-recipient resolver. Defaults to the real implementation
   * that walks `desktop_whatsapp_list_paired + matchByDisplayName`.
   * Tests pass a stub that returns the desired `WhatsAppResolution`.
   */
  resolveWhatsAppRecipient?: (query: string) => Promise<WhatsAppResolution>;
  /**
   * Inari Live V1 — Session 5. When set, the dock chat surface is
   * showing a server-anchored conversation; lifecycle slash commands
   * (`/snooze`, `/resolve`, `/witness verify`, …) operate on this id.
   * When unset (free chat / ambient surface), conversation commands
   * surface an inline "open a conversation first" note.
   */
  conversationId?: string | null;
  /**
   * Conversation-IPC dispatcher. Defaults to the cloud-IPC bridge
   * defined in `lib/cloud-ipc.ts` (S5). Tests pass an in-memory stub.
   */
  conversationIpc?: ConversationSlashIpc;
  /**
   * Cloud-IPC adapter for the structured slash commands (`/alerts`,
   * `/alert`, `/uptime`, `/oncall`). Defaults to the helpers exported
   * from `cloud-ipc.ts`; tests inject an in-memory stub.
   *
   * Tool-routed structured commands (`/projects`, `/health`, `/digest`,
   * `/search`) reuse the existing `invoke` field — they don't need a
   * separate cloud adapter.
   */
  cloudIpc?: SlashCloudIpc;
  /**
   * Phase 5.1 — surface a `{kind: "suspended", needs, partial}` result
   * to the dock UI. Set by `DockConversation` so the suspended-aware
   * pilot handlers (Phase 5.5–5.8) can request a slot picker. Legacy
   * handlers ignore this and keep pushing error notes via
   * `appendMessage` as before — wiring is non-breaking.
   *
   * Unset in test harnesses that don't render a slot UI; suspended
   * handlers fall back to a one-line error note in that case so the
   * dispatcher stays decisive regardless of caller.
   */
  onSuspended?: SuspendedHandler;
  /**
   * Phase 5.3 — append a scoped-memory entry. Handlers that produce
   * structured output (alerts, projects, paths) call this so the
   * Phase 5.4 autocomplete sees recent context and the Phase 5.5+
   * pickers can pre-fill / promote entities the user just looked at.
   *
   * Optional — when unset (test harnesses, legacy callers) the
   * handler skips memory recording without erroring. The dispatcher
   * does NOT auto-record from `formatOutcome` because raw IPC values
   * don't carry the entity shape pickers need; recording is per-
   * handler so each owns its own mapping.
   */
  recordMemory?: (entry: Omit<MemoryEntry, "timestamp">) => void;
  /**
   * Phase 5.6 completion — injection point for the project-link
   * probe (cloudProjectsList + projectGetLocalPath). Tests pass
   * stubs; production callers leave undefined to use the real IPCs.
   */
  installDeps?: InstallSuspendDeps;
}

/**
 * Minimal IPC surface S5 slash commands need. Defaults to the cloud
 * helpers when the chat surface doesn't override; tests pass a stub
 * that records the calls + asserts the resulting note copy.
 */
export interface ConversationSlashIpc {
  setState: (
    conversationId: string,
    args: {
      state: "active" | "snoozed" | "resolved" | "archived";
      snoozedUntil?: string;
      resolutionSummary?: string | null;
    },
  ) => Promise<void>;
  verifyChain: (conversationId: string) => Promise<{
    ok: boolean;
    totalMessages: number;
    firstBreakAt?: { messageId: string; reason: string } | null;
  }>;
}

/**
 * Returns `true` if the input was handled as a slash command (the
 * caller should NOT fall through to `sendMessage`). Returns `false`
 * for non-slash input — caller proceeds with the normal LLM path.
 *
 * Async work (IPC dispatch + the resulting assistant note) runs in
 * the background. The synchronous bool keeps the chat input handler
 * clean: "did we handle this turn?".
 */
export function handleSlashSubmit(input: string, ctx: SlashCtx): boolean {
  const parsed = parseSlashCommand(input);
  if (!parsed) return false;
  void dispatchSlashCommand(parsed, ctx);
  return true;
}

/**
 * Run a parsed slash command end-to-end. Always pushes the user's
 * typing as a user message first (so the chat transcript is honest
 * about what was said), then issues the IPC and appends an assistant
 * note describing the outcome.
 *
 * Errors at every layer surface as a single assistant note instead
 * of throwing — the chat surface stays linear and the user can
 * retype a corrected form below the error.
 */
export async function dispatchSlashCommand(
  parsedInput: SlashCommand,
  ctx: SlashCtx,
): Promise<void> {
  // Local re-binding so the Phase 5.6 install rewrite branch can
  // swap in augmented args without mutating the parameter. The
  // value is reassigned exactly once (inside the install branch);
  // every other step reads from this local.
  let parsed: SlashCommand = parsedInput;
  const invoke = ctx.invoke ?? realDesktopToolInvokeViaSlash;
  const echoed = formatEcho(parsed);

  // 1. Echo the user's typed slash as a normal user message.
  ctx.appendMessage(makeUserMessage(echoed));

  // 2. Meta-commands (`/help`, `/?`) short-circuit before the catalog
  //    lookup. They render the manifest as a help screen and never hit
  //    the backend, so no audit row is written. With an arg, narrow
  //    to a single command's detail view.
  if (META_COMMANDS.has(parsed.command)) {
    ctx.appendMessage(makeAssistantNote(formatHelp(parsed.args)));
    return;
  }

  // 2.5. `/github` and `/gh` resolve the active workspace's repo,
  //      then dispatch `desktop.open_url`. They DO produce an audit
  //      row (the open_url IPC runs); the special-case is just so
  //      the resolution step lives in one place.
  if (GITHUB_COMMANDS.has(parsed.command)) {
    await dispatchGithubCommand(parsed, ctx);
    return;
  }

  // 2.6. `/whatsapp` and `/wa` resolve a paired-WhatsApp display name
  //      (or raw E.164) into a phone, then dispatch `comm.send_whatsapp`.
  //      Same pattern as /github — async resolve, then standard
  //      slash invoke.
  if (WHATSAPP_COMMANDS.has(parsed.command)) {
    await dispatchWhatsAppCommand(parsed, ctx);
    return;
  }

  // 2.65. `/test <path>` — Inari Guard test generation. Resolves the
  //       active project's slug→id then calls /api/test-generation/start
  //       via Tauri IPC. Special-cased because we go to cloud HTTP, not
  //       through the desktop tool dispatcher.
  if (TEST_COMMANDS.has(parsed.command)) {
    await dispatchTestCommand(parsed, ctx);
    return;
  }

  // 2.67. `/install <path>` — Phase 5.6 suspend interception. When the
  //       dock surface wired `onSuspended`:
  //         - missing/invalid path → PathPickerSlot
  //         - valid path with no linked project → ProjectLinkSlot
  //           (wizard bridge)
  //         - valid path with existing project → rewrite the parsed
  //           args to inject `--project=<id>` and fall through so
  //           the catalog dispatches setup.install_capture with
  //           both args (avoids the "no project_id" tool error).
  //       The echo was already pushed at step 1.
  if (
    INSTALL_COMMANDS.has(parsed.command) &&
    typeof ctx.onSuspended === "function"
  ) {
    const result = await dispatchInstallSuspend(parsed, ctx, ctx.installDeps);
    if (result.kind === "suspended") return;
    if (result.kind === "rewrite") {
      // Replace the parsed args with the augmented form so the
      // catalog branch below sees a path-+-project invocation.
      // The echo was already pushed with the user's typed form
      // (without --project=...); that's fine — the augmentation
      // is for the IPC call, not the chat transcript.
      parsed = { command: parsed.command, args: result.args };
    }
    // `fallthrough` (or post-rewrite): drop into the catalog flow
    // below. We can't return here — the outer dispatcher would
    // re-echo on a "fall-through" return.
  }

  // 2.7. Simple meta-commands (/new, /clear, /settings, /audit,
  //      /devices, /theme, /voice) — each calls a store action or
  //      navigation IPC and pushes a confirmation note. No tool
  //      dispatch, no audit row.
  const simple = SIMPLE_META_HANDLERS[parsed.command];
  if (simple) {
    await simple(parsed, ctx);
    return;
  }

  // 2.8. Structured / cloud-IPC commands — `/projects`, `/health`,
  //      `/digest`, `/search` (tool-routed with rich rendering) +
  //      `/alerts`, `/alert`, `/uptime`, `/oncall` (cloud-IPC widgets).
  //      Each pushes its own assistant note with a markdown table /
  //      card / list. Handlers live in `slash/handlers.ts`.
  const structured = STRUCTURED_HANDLERS[parsed.command];
  if (structured) {
    await structured(parsed, {
      appendMessage: ctx.appendMessage,
      sessionId: ctx.sessionId,
      invoke: ctx.invoke,
      cloudIpc: ctx.cloudIpc,
      recordMemory: ctx.recordMemory,
      onSuspended: ctx.onSuspended,
    });
    return;
  }

  // 3. Catalog lookup.
  const entry = findSlashCommand(parsed.command);
  if (!entry) {
    // Phase 4.4 — surface a did-you-mean hint when the typed command
    // is within Levenshtein 3 of a real one. `formatUnknownCommand`
    // falls back to the plain "Type `/help`" line for truly off-the-
    // map input (so the message doesn't surface a misleading guess).
    ctx.appendMessage(makeAssistantNote(formatUnknownCommand(parsed.command)));
    return;
  }

  // 3. Args conversion.
  const argsResult = entry.parseArgs(parsed.args);
  if ("error" in argsResult) {
    ctx.appendMessage(
      makeAssistantNote(`\`/${parsed.command}\`: ${argsResult.error}`),
    );
    return;
  }

  // 4. IPC dispatch.
  try {
    const outcome = await invoke(entry.toolName, argsResult.args, ctx.sessionId);
    ctx.appendMessage(makeAssistantNote(formatOutcome(parsed.command, entry.toolName, outcome)));
    // Phase 5.6 — successful `/install` records the path so the next
    // PathPickerSlot (or `/health` pre-fill) has it at the top. The
    // record helper is best-effort; we don't await + don't error.
    if (
      INSTALL_COMMANDS.has(parsed.command) &&
      outcome.kind === "output" &&
      typeof (argsResult.args as { repo_path?: unknown }).repo_path === "string"
    ) {
      const repoPath = (argsResult.args as { repo_path: string }).repo_path;
      void recordRecentPathBest(repoPath);
    }
  } catch (err) {
    ctx.appendMessage(
      makeAssistantNote(`\`/${parsed.command}\` failed: ${formatError(err)}`),
    );
  }
}

/**
 * Fire-and-forget wrapper around the recent-paths IPC. Imported
 * lazily so dispatcher tests that don't mock Tauri don't trigger an
 * IPC error on the very first slash dispatch. Failures are silent —
 * the picker just won't see the new path on its next render.
 */
async function recordRecentPathBest(path: string): Promise<void> {
  try {
    const { recordRecentPath } = await import("./slash/entities/paths");
    await recordRecentPath(path);
  } catch {
    /* best-effort */
  }
}

/**
 * Same shape as `recordRecentPathBest` for /whatsapp: dynamic-import
 * the entity module so the dispatcher doesn't pull `@tauri-apps/api`
 * into the synchronous import graph. Best-effort.
 */
async function touchRecentContactBest(jid: string, name: string): Promise<void> {
  try {
    const { touchRecentContact } = await import("./slash/entities/contacts");
    await touchRecentContact(jid, name);
  } catch {
    /* best-effort */
  }
}

/**
 * Extract a readable string from any error shape. Tauri IPC throws
 * objects (not Error instances) shaped like `{ message: string }` or
 * `{ kind: ..., message: ... }`, so the naive `String(err)` returns
 * "[object Object]". This walker handles the common shapes and falls
 * back to JSON.stringify so we never surface "[object Object]" to
 * the chat.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

// ── /github dispatcher ──────────────────────────────────────────────────────

/**
 * Resolve the active workspace's GitHub repo, build the target URL,
 * and dispatch `desktop.open_url`. Errors at every layer (no active
 * repo, no origin, non-github host, unknown subcommand) surface as a
 * single assistant note — same UX as the rest of the slash pipeline.
 */
async function dispatchGithubCommand(
  parsed: SlashCommand,
  ctx: SlashCtx,
): Promise<void> {
  const subpath = githubSubpath(parsed.args);
  if (subpath === null) {
    ctx.appendMessage(
      makeAssistantNote(
        `Unknown \`/${parsed.command}\` subcommand \`${parsed.args}\`. Try one of: \`prs\`, \`issues\`, \`actions\`, \`releases\` (or just \`/${parsed.command}\` for the repo home).`,
      ),
    );
    return;
  }

  const resolve = ctx.resolveActiveGitHubRepo ?? realResolveActiveGitHubRepo;
  const resolution = await resolve();
  if (!resolution.ok) {
    ctx.appendMessage(makeAssistantNote(formatGithubFailure(resolution)));
    return;
  }

  const url = `${resolution.baseUrl}${subpath}`;
  const invoke = ctx.invoke ?? realDesktopToolInvokeViaSlash;
  try {
    const outcome = await invoke("desktop.open_url", { url }, ctx.sessionId);
    ctx.appendMessage(
      makeAssistantNote(formatOutcome(parsed.command, "desktop.open_url", outcome)),
    );
  } catch (err) {
    ctx.appendMessage(
      makeAssistantNote(`\`/${parsed.command}\` failed: ${formatError(err)}`),
    );
  }
}

/**
 * Format a `GitHubRepoResult` failure into a user-facing string. One
 * place to control wording so `/github` errors stay consistent.
 * Public for tests.
 */
export function formatGithubFailure(
  result: Extract<GitHubRepoResult, { ok: false }>,
): string {
  switch (result.reason) {
    case "no-active-repo":
      return "No active repo. Connect one in Settings → Repos, then try `/github` again.";
    case "no-origin-remote":
      return "Active repo has no `origin` remote. Run `git remote add origin <url>` and try again.";
    case "non-github-host":
      return `Active repo's origin is on \`${result.detail ?? "non-github host"}\`, not GitHub. Use \`/url <https://...>\` directly.`;
  }
}

// ── /whatsapp dispatcher ────────────────────────────────────────────────────

/**
 * Resolve a paired-WhatsApp display name into a phone, then dispatch
 * `comm.send_whatsapp`. Phase 5.5 made this suspend-aware:
 *
 *   - Empty args → suspend with ContactPickerSlot (kind=contact).
 *   - Recipient resolves to `none-paired` → same picker so the user
 *     can hit "+ Pair new" inline instead of being told to go to
 *     Settings.
 *   - Recipient resolves to `not-found` (wrong name, paired list
 *     non-empty) → suspend with the picker, search pre-filled with
 *     the user's query so the right contact is one keystroke away.
 *   - Recipient resolves to `ambiguous` → suspend with the picker
 *     scoped to the ambiguous candidates so the user disambiguates
 *     by tapping.
 *   - Recipient resolved, body missing → suspend with TextSlotModal
 *     (kind=text).
 *
 * On the happy path the IPC dispatch is unchanged. Legacy callers
 * (tests that don't wire `onSuspended`) still get the same error
 * notes via `formatWhatsAppFailure` — the suspend branch only fires
 * when `ctx.onSuspended` is set.
 */
async function dispatchWhatsAppCommand(
  parsed: SlashCommand,
  ctx: SlashCtx,
): Promise<void> {
  // Suspend-aware mode only activates when the surface wired
  // `onSuspended`. Headless / legacy callers fall through to the
  // pre-5.5 error-note path so existing tests stay green.
  const canSuspend = typeof ctx.onSuspended === "function";

  // No args at all → straight to the contact picker.
  if (canSuspend && parsed.args.trim().length === 0) {
    suspendWhatsApp(parsed.command, ctx, {
      slot: contactSlot(),
      partialArgs: {},
      rawArgs: "",
    });
    return;
  }

  const argsResult = parseWhatsAppArgs(parsed.args);
  if ("error" in argsResult) {
    if (canSuspend) {
      // Body missing — split the input on first whitespace and treat
      // everything before as the recipient query. If the recipient
      // half is empty (shouldn't happen post-`parsed.args.length`
      // check, defensive), go to the contact picker; otherwise
      // resolve the recipient and ask for the body next.
      const head = parsed.args.split(/\s+/, 1)[0] ?? "";
      if (!head) {
        suspendWhatsApp(parsed.command, ctx, {
          slot: contactSlot(),
          partialArgs: {},
          rawArgs: parsed.args,
        });
        return;
      }
      const resolve = ctx.resolveWhatsAppRecipient ?? realResolveWhatsAppRecipient;
      const resolution = await resolve(head);
      if (resolution.ok) {
        suspendWhatsApp(parsed.command, ctx, {
          slot: messageSlot(resolution.display_name),
          partialArgs: {
            recipient: resolution.phone,
            recipient_display: resolution.display_name,
          },
          rawArgs: resolution.display_name,
        });
        return;
      }
      // Recipient half couldn't resolve — surface via the contact
      // picker. The picker shows the available paired list / the
      // ambiguous candidates so the user fixes it without re-typing.
      suspendWhatsApp(parsed.command, ctx, {
        slot: contactSlot(),
        partialArgs: {},
        rawArgs: head,
      });
      return;
    }
    ctx.appendMessage(
      makeAssistantNote(`\`/${parsed.command}\`: ${argsResult.error}`),
    );
    return;
  }

  const resolve = ctx.resolveWhatsAppRecipient ?? realResolveWhatsAppRecipient;
  const resolution = await resolve(argsResult.recipient);
  if (!resolution.ok) {
    if (canSuspend) {
      suspendWhatsApp(parsed.command, ctx, {
        slot: contactSlot(),
        partialArgs: {},
        rawArgs: argsResult.recipient,
      });
      return;
    }
    ctx.appendMessage(makeAssistantNote(formatWhatsAppFailure(resolution)));
    return;
  }

  const invoke = ctx.invoke ?? realDesktopToolInvokeViaSlash;
  try {
    const outcome = await invoke(
      "comm.send_whatsapp",
      { to: resolution.phone, message: argsResult.message },
      ctx.sessionId,
    );
    ctx.appendMessage(
      makeAssistantNote(formatOutcome(parsed.command, "comm.send_whatsapp", outcome)),
    );
    // Phase 5.5 completion — record the recipient on the success
    // branch so the NEXT contact picker open promotes this number
    // above the (typically-empty) SAS list. Two sinks:
    //   1. Persistent store (recent_contacts table) — survives app
    //      restarts. Mirrors the /install → recent_paths pattern.
    //   2. Scoped memory — in-session ring used by the bilingual
    //      reference resolver ("esa persona"). The persistent store
    //      drives the picker promotion; scoped memory is gravy.
    // Errors and denials don't record — only confirmed sends make
    // the recipient "recent".
    if (outcome.kind === "output") {
      // Fire-and-forget; failures are silent (handled inside).
      void touchRecentContactBest(
        resolution.phone,
        resolution.display_name,
      );
      if (ctx.recordMemory) {
        ctx.recordMemory({
          commandName: parsed.command,
          args: { to: resolution.phone, message: argsResult.message },
          summary: `Sent WhatsApp to ${resolution.display_name}`,
          entities: [
            {
              type: "contact",
              jid: resolution.phone,
              name: resolution.display_name,
            },
          ],
        });
      }
    }
  } catch (err) {
    ctx.appendMessage(
      makeAssistantNote(`\`/${parsed.command}\` failed: ${formatError(err)}`),
    );
  }
}

/**
 * Hand a `SuspendedState` to the dock surface via `ctx.onSuspended`.
 * Build the SuspendedState with the right rebuild for the /whatsapp
 * resume flow — the rebuilder serialises `recipient` + `message` as
 * positional args.
 */
function suspendWhatsApp(
  command: string,
  ctx: SlashCtx,
  args: {
    slot: SlotSpec;
    partialArgs: Record<string, unknown>;
    rawArgs: string;
  },
): void {
  if (typeof ctx.onSuspended !== "function") return;
  ctx.onSuspended({
    needs: args.slot,
    partial: {
      command,
      collectedArgs: args.partialArgs,
      rawArgs: args.rawArgs,
    },
    rebuild: whatsappRebuild,
  });
}

/**
 * Serialiser for a resumed /whatsapp: recipient (jid — phone E.164)
 * first positional, message body second. The dispatcher re-runs
 * `parseWhatsAppArgs` on this string so the format must match what
 * the parser expects.
 *
 * Uses the jid (E.164) for the wire so re-resolution is a no-op
 * (E.164 escape hatch in `resolveWhatsAppRecipient`). Multi-line
 * messages are flattened to a single line — `/whatsapp` doesn't
 * support newlines in the slash form. Pure function; exported for
 * tests.
 */
export function whatsappRebuild(args: Record<string, unknown>): string {
  const recipient = typeof args.recipient === "string" ? args.recipient : "";
  const message = typeof args.message === "string"
    ? args.message.replace(/\s+/g, " ").trim()
    : "";
  return `/whatsapp ${recipient} ${message}`;
}

/** Slot spec for the "who?" picker. */
function contactSlot(): SlotSpec {
  return {
    kind: "contact",
    name: "recipient",
    prompt: "who?",
    // Placeholder intentionally omitted so the picker's own
    // default kicks in: "Search contacts or type +12025550100…".
    // The picker accepts free-text E.164 entry as a first-class
    // path (mirrors the resolver's escape hatch); a "Search
    // contacts…" placeholder would hide that.
  };
}

/** Slot spec for the "message body" textarea. */
function messageSlot(displayName?: string): SlotSpec {
  return {
    kind: "text",
    name: "message",
    prompt: displayName ? `to ${displayName}` : "message",
    placeholder: "Type a message…",
  };
}

// ── /install suspend interception (Phase 5.6) ───────────────────────────────

/**
 * Phase 5.6 — detect missing args on `/install` and hand the right
 * slot to the dock surface.
 *
 * Two slot paths:
 *   1. Missing or non-absolute path → PathPickerSlot (existing).
 *   2. Path valid AND no `--project=<id>` AND no project linked to
 *      that path yet → ProjectLinkSlot bridge to AddProjectWizard
 *      (Phase 5.6 completion — closes the gap left by commit
 *      73598487 which only implemented path #1).
 *
 * The project-lookup short-circuits when:
 *   - The user passed `--project=<id>` explicitly (we trust it).
 *   - The IPCs fail (we let the catalog handle the resulting tool
 *     error — degrades to pre-5.6 behavior).
 *   - A project is already linked to the path (we inject its id
 *     so the catalog dispatches normally).
 *
 * Returns `true` when the dispatcher should stop (suspended OR
 * project_id was auto-injected and the dispatcher should call the
 * tool directly with the augmented args — see SuspendOutcome).
 *
 * Async because the project-link probe issues an IPC; cheap on the
 * happy path (one cloudProjectsList + one projectGetLocalPath per
 * project, usually <10 entries total).
 */
export interface InstallSuspendDeps {
  listProjects?: () => Promise<{ projects: Array<{ id: string; name: string }> }>;
  getLocalPath?: (projectId: string) => Promise<string | null>;
}

export type InstallSuspendResult =
  | { kind: "fallthrough" }                                    // normal catalog dispatch with raw args
  | { kind: "suspended" }                                       // ctx.onSuspended was called
  | { kind: "rewrite"; args: string };                         // inject --project=<id>, re-parse

async function dispatchInstallSuspend(
  parsed: SlashCommand,
  ctx: SlashCtx,
  deps: InstallSuspendDeps = {},
): Promise<InstallSuspendResult> {
  if (typeof ctx.onSuspended !== "function") {
    return { kind: "fallthrough" };
  }
  const trimmed = parsed.args.trim();
  // Mirror the catalog's flag-aware parsing — split on the optional
  // `--project=<id>` and treat the remainder as the path.
  const projectMatch = trimmed.match(/(^|\s)--project=(\S+)(\s|$)/);
  const path = projectMatch
    ? trimmed.replace(projectMatch[0], " ").trim()
    : trimmed;

  // Slot 1 — missing or non-absolute path. Suspends with PathPicker.
  if (!path || !isAbsolutePathForInstall(path)) {
    const collectedArgs: Record<string, unknown> = {};
    if (projectMatch?.[2]) {
      collectedArgs.project_id = projectMatch[2];
    }
    ctx.onSuspended({
      needs: {
        kind: "path",
        name: "path",
        prompt: "which folder?",
        placeholder: "Pick a recent folder or browse…",
      },
      partial: {
        command: parsed.command,
        collectedArgs,
        rawArgs: trimmed,
      },
      rebuild: installRebuild,
    });
    return { kind: "suspended" };
  }

  // User passed `--project=<id>` explicitly — trust it, fall through
  // so the catalog calls setup.install_capture with both args.
  if (projectMatch?.[2]) {
    return { kind: "fallthrough" };
  }

  // Slot 2 — probe whether a project is already linked to this path.
  // No match → suspend with project_link slot (renders the wizard
  // inline). Match → inject `--project=<id>` and ask the dispatcher
  // to re-parse with the rewritten args.
  let existing: { id: string; name: string } | null = null;
  try {
    existing = await findProjectByLocalPath(path, deps);
  } catch {
    // IPC failed — let the catalog dispatch and surface the tool's
    // own error message. Degrades to pre-5.6 behavior.
    return { kind: "fallthrough" };
  }

  if (existing) {
    return {
      kind: "rewrite",
      args: `${path} --project=${existing.id}`,
    };
  }

  // No matching project — surface the wizard bridge.
  ctx.onSuspended({
    needs: {
      kind: "project_link",
      name: "project_id",
      prompt: "link a project",
      placeholder: undefined,
      optionsHint: { path },
    },
    partial: {
      command: parsed.command,
      collectedArgs: { path },
      rawArgs: trimmed,
    },
    rebuild: installRebuild,
  });
  return { kind: "suspended" };
}

/**
 * Walk the user's cloud projects + look up each one's locally-stored
 * clone path. Return the first match (case-insensitive on Windows,
 * exact match elsewhere). Returns `null` when no project is linked
 * to `path` — the caller suspends with the project-link wizard in
 * that case. Exported for tests.
 */
export async function findProjectByLocalPath(
  path: string,
  deps: InstallSuspendDeps = {},
): Promise<{ id: string; name: string } | null> {
  const listProjects =
    deps.listProjects ??
    (async () => {
      const { cloudProjectsList } = await import("./cloud-ipc");
      const result = await cloudProjectsList();
      return {
        projects: result.projects.map((p) => ({ id: p.id, name: p.name })),
      };
    });
  const getLocalPath =
    deps.getLocalPath ??
    (async (id: string) => {
      const { projectGetLocalPath } = await import("./ipc/project-local");
      return projectGetLocalPath(id);
    });

  const { projects } = await listProjects();
  const target = normalizePath(path);
  for (const p of projects) {
    let local: string | null = null;
    try {
      local = await getLocalPath(p.id);
    } catch {
      continue; // skip the row, keep probing.
    }
    if (local && normalizePath(local) === target) {
      return { id: p.id, name: p.name };
    }
  }
  return null;
}

/**
 * Normalise a path for equality comparison: trim, drop trailing
 * slashes (except for root markers), and lowercase on Windows so
 * `D:\Web` and `d:\web` are considered the same project. POSIX
 * paths stay case-sensitive.
 */
function normalizePath(p: string): string {
  const trimmed = p.trim().replace(/[\\\/]+$/, "");
  // Windows drive letter prefix → case-insensitive.
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

/**
 * Serialise a resumed `/install`. Positional path first; optional
 * `--project=<id>` appended when the partial carried it. Pure
 * function — exported for tests.
 */
export function installRebuild(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  const projectId = typeof args.project_id === "string" ? args.project_id : "";
  const flag = projectId ? ` --project=${projectId}` : "";
  return `/install ${path}${flag}`;
}

// ── /test dispatcher (Inari Guard) ─────────────────────────────────────────

/**
 * Parse a `/test <path>` invocation. Path is required, must be
 * non-empty, and cannot start with `/` or contain `..` to keep the
 * lookup safe (the Rust side enforces this again — defence in depth).
 */
export type TestArgsResult =
  | { path: string }
  | { error: string };

export function parseTestArgs(rawArgs: string): TestArgsResult {
  const path = rawArgs.trim();
  if (!path) {
    return {
      error: "Path required. Try `/test src/lib/auth.ts` (path is repo-relative).",
    };
  }
  if (path.startsWith("/") || path.startsWith("\\")) {
    return {
      error: "Path must be relative to the repo root (no leading `/`). Try `src/lib/auth.ts`.",
    };
  }
  if (path.split(/[\/\\]/).some((seg) => seg === "..")) {
    return { error: "Path cannot contain `..` — keep it inside the repo." };
  }
  return { path };
}

/**
 * Resolve the active chat's project slug into a cloud project id via
 * `cloudProjectsList()`. Returns `null` (with the right user-facing
 * message already pushed) when no project is selected or the lookup
 * fails.
 *
 * Why slug instead of id in the store: the chat store mirrors the
 * URL (`/c/<slug>`) so a refresh restores the right thread. The id is
 * a one-line lookup away when the user dispatches an action.
 */
async function dispatchTestCommand(
  parsed: SlashCommand,
  ctx: SlashCtx,
): Promise<void> {
  const argsResult = parseTestArgs(parsed.args);
  if ("error" in argsResult) {
    ctx.appendMessage(
      makeAssistantNote(`\`/${parsed.command}\`: ${argsResult.error}`),
    );
    return;
  }

  // Resolve active project slug → id. The chat store mirrors the URL,
  // so the slug is always available when the user is inside a project
  // chat. Outside a project (free chat / ambient), surface the hint
  // instead of guessing.
  const slug = useChat.getState().activeProjectSlug;
  if (!slug) {
    ctx.appendMessage(
      makeAssistantNote(
        "`/test` needs an active project. Pick a project from the sidebar (or `Ctrl/Cmd+P`), then try `/test <path>` again.",
      ),
    );
    return;
  }

  let projectId: string | null = null;
  try {
    const { cloudProjectsList } = await import("./cloud-ipc");
    const list = await cloudProjectsList();
    const match = list.projects.find((p) => p.slug === slug);
    projectId = match?.id ?? null;
  } catch (err) {
    ctx.appendMessage(
      makeAssistantNote(`\`/test\` failed to load projects: ${formatError(err)}`),
    );
    return;
  }

  if (!projectId) {
    ctx.appendMessage(
      makeAssistantNote(
        `\`/test\`: active project \`${slug}\` isn't in your cloud project list. Run \`/settings\` and re-link the project.`,
      ),
    );
    return;
  }

  // Spin the live "Generating…" note so the chat surface reflects the
  // ~30-60s pipeline. We push a separate note for the final outcome.
  ctx.appendMessage(
    makeAssistantNote(`Generating tests for \`${argsResult.path}\` — typically 30-60s.`),
  );

  try {
    const { cloudGenerateTest } = await import("./cloud-ipc");
    const result = await cloudGenerateTest(projectId, argsResult.path, "inline");
    ctx.appendMessage(makeAssistantNote(formatTestOutcome(result)));
  } catch (err) {
    ctx.appendMessage(
      makeAssistantNote(`\`/test\` failed: ${formatError(err)}`),
    );
  }
}

/**
 * Render a `TestGenResult` as a markdown assistant note. Public for
 * tests. The session detail page (`/tests/<id>`) has the full plan,
 * gates, and reviewer verdict — the chat note just summarises so the
 * user can click through.
 */
export function formatTestOutcome(result: import("./cloud-ipc").TestGenResult): string {
  const cost = `$${(result.costCents / 100).toFixed(3)}`;
  const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
  const meta = `${cost} · ${duration}`;

  if (result.status === "failed") {
    const why = result.error ? ` — ${result.error}` : "";
    return `✗ Generation failed${why}. ${meta}.`;
  }
  if (!result.testFile) {
    return `Generation completed but no test file returned. ${meta}.`;
  }
  const prLine = result.prUrl
    ? `\n\nPR opened: ${result.prUrl}`
    : "";
  const detailLink = `[View detail · plan · gates · code](inariwatch://tests/${result.sessionId})`;
  return [
    `✓ Test ready — \`${result.testFile.path}\` · ${meta}.`,
    "",
    "```typescript",
    result.testFile.content.slice(0, 4000),
    result.testFile.content.length > 4000 ? "// … truncated, open the detail view for full file" : "",
    "```",
    detailLink + prLine,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Format a `WhatsAppResolution` failure for the chat surface. Each
 * branch maps to a distinct, actionable hint (pair first, see
 * available names, disambiguate by tail, etc.). Public for tests.
 */
export function formatWhatsAppFailure(
  result: Extract<WhatsAppResolution, { ok: false }>,
): string {
  switch (result.reason) {
    case "none-paired":
      return "No WhatsApp paired. Pair one in Settings → Channels, then try `/whatsapp <name> <message>` again.";
    case "not-found": {
      const top = result.available.slice(0, 5).map((n) => `\`${n}\``);
      const more = result.available.length > 5
        ? ` (+${result.available.length - 5} more)`
        : "";
      const suffix = top.length > 0
        ? ` Available: ${top.join(", ")}${more}.`
        : "";
      return `No paired WhatsApp matches that name.${suffix} You can also pass a `
        + "raw E.164 number like `+5215512345678`.";
    }
    case "ambiguous": {
      const list = result.candidates
        .slice(0, 5)
        .map((c) => `\`${c.display_name}\` (${c.redacted})`);
      return `Multiple WhatsApp matches. Be more specific: ${list.join(", ")}.`;
    }
  }
}

// ── Simple meta-command handlers ────────────────────────────────────────────
//
// Each handler is a thin wrapper that calls ONE store action or
// navigation IPC and pushes a confirmation note. They're imported
// directly (not via SlashCtx fields) — tests can vi.mock the store
// module if they need to inspect the side effect.

function handleNewConversation(_: SlashCommand, ctx: SlashCtx): void {
  useChat.getState().clearConversation();
  ctx.appendMessage(
    makeAssistantNote("Started a new conversation."),
  );
}

/**
 * `/clear` — two-step destructive action.
 *
 * Phase 4.3 of the pure-slash refactor (2026-05-15) added the
 * confirmation step. `/clear` (no arg) on a non-empty thread previews
 * the action and asks the user to retype `/clear yes`. `/clear yes`
 * (or `/clear --confirm` / `/clear confirm`) bypasses the prompt and
 * wipes the thread. An empty thread no-ops with a friendly note
 * either way — there's nothing to clear, and asking would just feel
 * like noise.
 *
 * The pattern is deliberately stateless (no timer, no module-level
 * "is a /clear pending?" flag): typing `yes` IS the consent, full
 * stop. If the user accidentally types `/clear yes` without a prior
 * `/clear` they still get what they asked for — explicit. Mirrors how
 * `git push --force-with-lease` etc. require the confirmation word to
 * be retyped rather than relying on a session-state coupling.
 */
const CLEAR_CONFIRM_TOKENS = new Set(["yes", "y", "confirm", "--confirm"]);

function handleClearConversation(parsed: SlashCommand, ctx: SlashCtx): void {
  const arg = parsed.args.trim().toLowerCase();
  const messageCount = useChat.getState().messages.length;

  // Empty thread — short-circuit before either branch. Echo + a
  // friendly note; no destructive action to take.
  if (messageCount === 0) {
    ctx.appendMessage(makeAssistantNote("Conversation is already empty."));
    return;
  }

  // Confirmed — wipe and push a fresh assistant note (the note
  // becomes the first message in the cleared thread). Bumping the
  // "user echo" already happened upstream in dispatchSlashCommand, so
  // the cleared thread is genuinely empty until the note lands.
  if (arg && CLEAR_CONFIRM_TOKENS.has(arg)) {
    useChat.getState().clearConversation();
    ctx.appendMessage(makeAssistantNote("Conversation cleared."));
    return;
  }

  // First step — describe the destructive action and ask for the
  // confirmation token. Avoids ever wiping history on a single typo
  // (the old behavior would wipe on a bare `/clear`).
  ctx.appendMessage(
    makeAssistantNote(
      `This will clear ${messageCount} message${messageCount === 1 ? "" : "s"} from the current thread. Type \`/clear yes\` to confirm.`,
    ),
  );
}

async function handleSettings(_: SlashCommand, ctx: SlashCtx): Promise<void> {
  await openMainWindow("settings");
  ctx.appendMessage(makeAssistantNote("Opened Settings."));
}

async function handleAudit(_: SlashCommand, ctx: SlashCtx): Promise<void> {
  await openMainWindow("audit");
  ctx.appendMessage(makeAssistantNote("Opened audit log."));
}

async function handleDevices(_: SlashCommand, ctx: SlashCtx): Promise<void> {
  // Settings → Channels surfaces both paired phones (WhatsApp) and
  // paired devices (Mobile). The route deep-links to the Channels
  // sub-section so the user lands on the right tab.
  await navigateTo("main", "/settings/channels");
  ctx.appendMessage(
    makeAssistantNote("Opened Settings → Channels."),
  );
}

/**
 * `/theme <light|dark|system>` — switches the theme via useAppState.
 * "system" is the user-facing word; the store calls it "auto".
 */
function handleTheme(parsed: SlashCommand, ctx: SlashCtx): void {
  const arg = parsed.args.trim().toLowerCase();
  // Empty arg → show current theme + usage hint.
  if (!arg) {
    const current = useAppState.getState().themeMode;
    ctx.appendMessage(
      makeAssistantNote(
        `Theme is \`${current}\`. Use \`/theme <light|dark|system>\` to switch.`,
      ),
    );
    return;
  }
  const mode: ThemeMode | null =
    arg === "system" ? "auto"
    : arg === "light" ? "light"
    : arg === "dark"  ? "dark"
    : null;
  if (mode === null) {
    ctx.appendMessage(
      makeAssistantNote(
        `\`/theme\`: Unknown mode \`${arg}\`. Try \`light\`, \`dark\`, or \`system\`.`,
      ),
    );
    return;
  }
  useAppState.getState().setThemeMode(mode);
  ctx.appendMessage(
    makeAssistantNote(`Theme set to \`${arg === "system" ? "system (auto)" : arg}\`.`),
  );
}

/**
 * `/voice <on|off>` — toggles the voice input setting.
 * The voice store handles the IPC + optimistic update; we just
 * forward the boolean.
 */
async function handleVoice(parsed: SlashCommand, ctx: SlashCtx): Promise<void> {
  const arg = parsed.args.trim().toLowerCase();
  if (!arg) {
    const current = useVoiceSettings.getState().settings.input_enabled;
    ctx.appendMessage(
      makeAssistantNote(
        `Voice input is ${current ? "on" : "off"}. Use \`/voice on\` or \`/voice off\`.`,
      ),
    );
    return;
  }
  if (arg !== "on" && arg !== "off") {
    ctx.appendMessage(
      makeAssistantNote(
        `\`/voice\`: Try \`/voice on\` or \`/voice off\`.`,
      ),
    );
    return;
  }
  await useVoiceSettings.getState().patch({ input_enabled: arg === "on" });
  ctx.appendMessage(makeAssistantNote(`Voice input ${arg}.`));
}

// ── Inari Live V1 Session 5 conversation slash handlers ────────────────────

/**
 * Default IPC adapter — wraps the cloud-IPC functions in `cloud-ipc.ts`.
 * Tests pass an in-memory stub via `ctx.conversationIpc`.
 */
async function realConversationIpc(): Promise<ConversationSlashIpc> {
  // Lazy-import to avoid pulling Tauri code into headless test runs of
  // the slash dispatcher. The cloud-ipc module is itself defensive
  // about Tauri-runtime presence.
  const mod = await import("./cloud-ipc");
  return {
    setState: async (id, args) => {
      await mod.cloudConversationsSetState(id, {
        state: args.state,
        snoozedUntil: args.snoozedUntil,
        resolutionSummary: args.resolutionSummary,
      });
    },
    verifyChain: async (id) => {
      return mod.cloudConversationsVerifyChain(id);
    },
  };
}

function requireConversationCtx(parsed: SlashCommand, ctx: SlashCtx): string | null {
  if (ctx.conversationId) return ctx.conversationId;
  ctx.appendMessage(
    makeAssistantNote(
      `\`/${parsed.command}\` needs an open conversation. Click an alert in the inbox first.`,
    ),
  );
  return null;
}

async function handleConversationSnooze(parsed: SlashCommand, ctx: SlashCtx): Promise<void> {
  const id = requireConversationCtx(parsed, ctx);
  if (!id) return;
  const { parseSnoozeUntil } = await import("./snooze-parser");
  const result = parseSnoozeUntil(parsed.args);
  if ("error" in result) {
    ctx.appendMessage(makeAssistantNote(`\`/snooze\`: ${result.error}`));
    return;
  }
  const ipc = ctx.conversationIpc ?? (await realConversationIpc());
  try {
    await ipc.setState(id, {
      state: "snoozed",
      snoozedUntil: result.until.toISOString(),
    });
    ctx.appendMessage(makeAssistantNote(`Snoozed until ${result.until.toLocaleString()}.`));
  } catch (err) {
    ctx.appendMessage(makeAssistantNote(`\`/snooze\` failed: ${formatError(err)}`));
  }
}

async function handleConversationResolve(parsed: SlashCommand, ctx: SlashCtx): Promise<void> {
  const id = requireConversationCtx(parsed, ctx);
  if (!id) return;
  const summary = parsed.args.trim() || null;
  const ipc = ctx.conversationIpc ?? (await realConversationIpc());
  try {
    await ipc.setState(id, { state: "resolved", resolutionSummary: summary });
    ctx.appendMessage(makeAssistantNote(`Resolved.${summary ? ` ${summary}` : ""}`));
  } catch (err) {
    ctx.appendMessage(makeAssistantNote(`\`/resolve\` failed: ${formatError(err)}`));
  }
}

async function handleConversationReopen(parsed: SlashCommand, ctx: SlashCtx): Promise<void> {
  const id = requireConversationCtx(parsed, ctx);
  if (!id) return;
  const ipc = ctx.conversationIpc ?? (await realConversationIpc());
  try {
    await ipc.setState(id, { state: "active" });
    ctx.appendMessage(makeAssistantNote("Reopened."));
  } catch (err) {
    ctx.appendMessage(makeAssistantNote(`\`/reopen\` failed: ${formatError(err)}`));
  }
}

async function handleConversationArchive(parsed: SlashCommand, ctx: SlashCtx): Promise<void> {
  const id = requireConversationCtx(parsed, ctx);
  if (!id) return;
  const ipc = ctx.conversationIpc ?? (await realConversationIpc());
  try {
    await ipc.setState(id, { state: "archived" });
    ctx.appendMessage(makeAssistantNote("Archived."));
  } catch (err) {
    ctx.appendMessage(makeAssistantNote(`\`/archive\` failed: ${formatError(err)}`));
  }
}

function handleConversationAck(parsed: SlashCommand, ctx: SlashCtx): void {
  if (!requireConversationCtx(parsed, ctx)) return;
  ctx.appendMessage(
    makeAssistantNote(
      "Acknowledge wiring lands with the alert-services bridge in V1.5. The conversation stays open for now.",
    ),
  );
}

function handleConversationSilence(parsed: SlashCommand, ctx: SlashCtx): void {
  if (!requireConversationCtx(parsed, ctx)) return;
  ctx.appendMessage(
    makeAssistantNote(
      "Silence wiring routes through the existing alert-silence service — UI bridge in V1.5.",
    ),
  );
}

function handleConversationEscalate(parsed: SlashCommand, ctx: SlashCtx): void {
  if (!requireConversationCtx(parsed, ctx)) return;
  ctx.appendMessage(
    makeAssistantNote(
      "Escalation wiring routes through the on-call engine — UI bridge in V1.5.",
    ),
  );
}

function handleConversationSummarize(parsed: SlashCommand, ctx: SlashCtx): void {
  if (!requireConversationCtx(parsed, ctx)) return;
  ctx.appendMessage(
    makeAssistantNote(
      "Summarize relays to /api/chat with the conversation context — bridge ships in V1.5.",
    ),
  );
}

function handleConversationExport(parsed: SlashCommand, ctx: SlashCtx): void {
  if (!requireConversationCtx(parsed, ctx)) return;
  const fmt = parsed.args.trim().toLowerCase();
  if (fmt && fmt !== "md" && fmt !== "json") {
    ctx.appendMessage(makeAssistantNote("`/export`: format must be `md` or `json`."));
    return;
  }
  ctx.appendMessage(
    makeAssistantNote(
      "Export bridge ships in V1.5. Use `/witness export` today to get the chain receipt.",
    ),
  );
}

async function handleConversationWitness(parsed: SlashCommand, ctx: SlashCtx): Promise<void> {
  const id = requireConversationCtx(parsed, ctx);
  if (!id) return;
  const sub = parsed.args.trim().toLowerCase();
  if (sub === "" || sub === "verify") {
    const ipc = ctx.conversationIpc ?? (await realConversationIpc());
    try {
      const result = await ipc.verifyChain(id);
      if (result.ok) {
        ctx.appendMessage(
          makeAssistantNote(
            `✓ verified · ${result.totalMessages} message${result.totalMessages === 1 ? "" : "s"} chained correctly.`,
          ),
        );
        return;
      }
      if (result.firstBreakAt?.reason === "missing_hash") {
        ctx.appendMessage(
          makeAssistantNote(
            `⚠ unverifiable · chain not fully populated (legacy row at ${result.firstBreakAt.messageId.slice(0, 8)}).`,
          ),
        );
        return;
      }
      ctx.appendMessage(
        makeAssistantNote(
          `✗ tampered · break detected at message ${result.firstBreakAt?.messageId.slice(0, 8) ?? "?"}.`,
        ),
      );
    } catch (err) {
      ctx.appendMessage(makeAssistantNote(`\`/witness verify\` failed: ${formatError(err)}`));
    }
    return;
  }
  if (sub === "export") {
    ctx.appendMessage(
      makeAssistantNote(
        "Receipt export available via `cloudConversationsVerifyChain` IPC — UI surface in V1.5.",
      ),
    );
    return;
  }
  ctx.appendMessage(
    makeAssistantNote(`Unknown \`/witness\` subcommand \`${sub}\`. Try \`verify\` or \`export\`.`),
  );
}

// ── Internals (exposed for tests in __tests__/slash-dispatch.test.ts) ────────

export function formatEcho(parsed: SlashCommand): string {
  return parsed.args ? `/${parsed.command} ${parsed.args}` : `/${parsed.command}`;
}

/**
 * Render the slash-command help screen for `/help [filter]`. Phase 4.2
 * upgrades the previous one-shot bullet list into three views, sourced
 * from `SLASH_MANIFEST` (the canonical catalog with full args +
 * examples per entry):
 *
 *   - **No filter** → the full catalog as a one-line-per-command list
 *     with a footer hint: `/help <name>` for args + examples.
 *   - **Filter that exact-matches OR fuzzy-narrows to one command** →
 *     a detail block: name, description, arg table (type, required,
 *     enum values), examples block, footer with the back-to-list hint.
 *   - **Filter that fuzzy-matches multiple commands** → the filtered
 *     list with a header noting the match count + the same detail
 *     hint as the full list.
 *   - **Filter that matches nothing** → a one-line "No commands match
 *     `<filter>`" with the back-to-list hint.
 *
 * Filtering is a case-insensitive substring match against the command
 * name OR its 1-line description. Leading `/` on the filter is
 * stripped so `/help /projects` and `/help projects` behave the same.
 *
 * The function stays pure (returns markdown) so callers can either
 * render it inline in the chat (the dispatcher's default) or unit-test
 * the output verbatim.
 */
export function formatHelp(filter?: string): string {
  const raw = (filter ?? "").trim();
  if (!raw) {
    return renderHelpFullList(SLASH_MANIFEST);
  }
  // Strip a leading `/` so `/help /projects` works as a shortcut.
  const needle = (raw.startsWith("/") ? raw.slice(1) : raw).toLowerCase();
  if (!needle) {
    return renderHelpFullList(SLASH_MANIFEST);
  }

  // Exact-name match first (case-insensitive). The manifest stores
  // names with the leading slash, so we compare against the slug.
  const exact = SLASH_MANIFEST.find(
    (e) => e.name.toLowerCase().slice(1) === needle,
  );
  if (exact) return renderHelpDetail(exact);

  // Substring match against name + description. Walking the manifest
  // once keeps the iteration order stable (workspace queries first).
  const matches = SLASH_MANIFEST.filter(
    (e) =>
      e.name.toLowerCase().slice(1).includes(needle) ||
      e.description.toLowerCase().includes(needle),
  );

  if (matches.length === 0) {
    return `No commands match \`${raw}\`. Type \`/help\` for the full list.`;
  }
  if (matches.length === 1) {
    return renderHelpDetail(matches[0]!);
  }
  return renderHelpFilteredList(matches, raw);
}

function renderHelpFullList(entries: readonly ManifestCommand[]): string {
  const lines = entries.map(
    (e) => `- \`${e.name}\` — ${e.description}`,
  );
  return [
    "**Available slash commands**",
    "",
    ...lines,
    "",
    "Type `/help <name>` for args + examples (e.g. `/help projects`).",
    "",
    "Slash commands bypass the Confirm permission gate but respect Deny — set in Settings → Permissions.",
  ].join("\n");
}

function renderHelpFilteredList(
  entries: readonly ManifestCommand[],
  filter: string,
): string {
  const lines = entries.map(
    (e) => `- \`${e.name}\` — ${e.description}`,
  );
  return [
    `**Commands matching \`${filter}\`** — ${entries.length} match${entries.length === 1 ? "" : "es"}`,
    "",
    ...lines,
    "",
    "Type `/help <name>` for args + examples on one command.",
  ].join("\n");
}

function renderHelpDetail(entry: ManifestCommand): string {
  const lines: string[] = [];
  lines.push(`**${entry.name}** — ${entry.description}`);
  lines.push("");

  if (entry.args.length > 0) {
    lines.push("**Arguments:**");
    for (const arg of entry.args) {
      const flagPart = arg.flag
        ? `\`--${arg.flag}=<${arg.name}>\``
        : `\`${arg.name}\``;
      const reqPart = arg.required ? " *(required)*" : " *(optional)*";
      const typePart = ` *(${arg.type})*`;
      const enumPart =
        arg.enumValues && arg.enumValues.length > 0
          ? ` — values: ${arg.enumValues.map((v) => `\`${v}\``).join(", ")}`
          : "";
      lines.push(
        `- ${flagPart}${typePart}${reqPart} — ${arg.description}${enumPart}`,
      );
    }
    lines.push("");
  } else {
    lines.push("_No arguments._");
    lines.push("");
  }

  if (entry.examples.length > 0) {
    lines.push("**Examples:**");
    for (const ex of entry.examples) {
      lines.push(`- \`${ex}\``);
    }
    lines.push("");
  }

  lines.push("Type `/help` for the full command list.");
  return lines.join("\n");
}

export function formatOutcome(
  command: string,
  toolName: string,
  outcome: InvokeOutcome,
): string {
  if (outcome.kind === "output") {
    return outcome.output.summary ?? `Done — \`${toolName}\` ran.`;
  }
  if (outcome.kind === "denied") {
    // Backend already formats `reason` as a "set in Settings → Permissions"
    // hint. We render it verbatim so the wording stays single-source.
    return outcome.reason;
  }
  // requires_confirm shouldn't reach the slash path (the IPC bypasses
  // Confirm). If we see it, something's wrong — surface it loudly.
  return `\`/${command}\` returned \`requires_confirm\` — that's a bug, slash should bypass Confirm.`;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  // Date.now() + a counter dodges duplicate ids when two slash
  // dispatches land in the same ms (synchronous appendMessage path).
  return `${prefix}_${Date.now()}_${counter}`;
}

function makeUserMessage(content: string): ChatMessage {
  return {
    id: nextId("slash_user"),
    role: "user",
    content,
    createdAt: Date.now(),
  };
}

function makeAssistantNote(content: string): ChatMessage {
  return {
    id: nextId("slash_note"),
    role: "assistant",
    content,
    createdAt: Date.now(),
  };
}

// ── Phase 5.1 — SuspendedCommand resume ─────────────────────────────────────

/**
 * Resume a previously-suspended slash command after the dock surface
 * collected a slot value via `<SlotPicker>`. The dispatcher re-builds
 * the synthetic input from the partial state plus the freshly-picked
 * value and re-runs `dispatchSlashCommand` with it — preserving every
 * existing invariant (echo first, audit row from the IPC layer, error
 * notes via `appendMessage`).
 *
 * The `rebuild` function travels with each `SuspendedState`, so the
 * dispatcher stays agnostic to arg shape: positional vs flag, quoting
 * rules, alternate representations (e.g. `/whatsapp Jose ...` vs
 * `/whatsapp +5215... ...`) — all owned by the pilot handler.
 */
export interface ResumeArgs {
  /** Partial command captured at suspend time. */
  partial: PartialCommand;
  /** Slot spec the user just filled. */
  spec: SlotSpec;
  /**
   * Merged collected args after the picker resolved. Pilot handlers
   * compute this with `mergeSlotValue` from `suspended-command.ts`.
   */
  mergedArgs: Record<string, unknown>;
  /** Dispatcher context — same shape as the original dispatch. */
  ctx: SlashCtx;
  /**
   * Per-command serializer carried over from the suspended state.
   * Re-using the rebuilder that came with the suspend means resume
   * stays decoupled from a per-command registry.
   */
  rebuild: Rebuild;
}

/**
 * Re-dispatch a suspended command with the merged args. Returns
 * a promise that resolves when the underlying dispatch finishes
 * (or another suspend lands — the caller handles both).
 */
export async function resumeSlashCommand(args: ResumeArgs): Promise<void> {
  const rebuilt = args.rebuild(args.mergedArgs);
  const parsed = parseSlashCommand(rebuilt);
  if (!parsed) {
    args.ctx.appendMessage(
      makeAssistantNote(
        `\`/${args.partial.command}\` resume failed: rebuilt input was not a valid slash command.`,
      ),
    );
    return;
  }
  await dispatchSlashCommand(parsed, args.ctx);
}
