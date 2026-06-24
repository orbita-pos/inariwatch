/**
 * Slash-command catalog. Maps user-typed `/<command>` to a backend tool
 * name + arg-shape conversion.
 *
 * Adding a new slash command:
 *   1. Pick a short, lowercase, easy-to-type name (e.g. "code", "radio").
 *   2. Pick the underlying backend tool (must exist in
 *      `desktop_tool_catalog`).
 *   3. Implement `parseArgs(rawArgs)` which maps the tail string to the
 *      tool's `params_schema`.
 *
 * Slash commands route through `desktop_tool_invoke_via_slash` IPC,
 * which bypasses the Confirm gate (the typing IS the consent) but
 * STILL respects a per-tool `Deny` override from Settings →
 * Permissions. See `feedback_no_proprietary_ai.md` for the trust
 * ladder design.
 *
 * The catalog is intentionally hand-curated, NOT auto-generated from
 * `desktop_tool_catalog`, because slash commands are user-facing and
 * deserve readable names + targeted help text. Auto-discovery would
 * lock us to the namespaced tool names like `desktop.open_in_editor`.
 */

/**
 * The shape `parseArgs` returns. `args` becomes the JSON object passed
 * to the tool; `error` is shown inline in the chat without invoking.
 */
export type SlashArgsResult =
  | { args: Record<string, unknown> }
  | { error: string };

export type SlashCatalogEntry = {
  /** User-typed command, sans leading slash. Lowercase. */
  command: string;
  /** One-line help text shown in the palette + on `/?`. */
  description: string;
  /** Backend tool to invoke (must match a `ToolMeta.name` exactly). */
  toolName: string;
  /**
   * Optional brand color for the autocomplete + /help. CSS color
   * string (hex, var, etc.). When present, the SlashAutocomplete
   * paints `/<command>` in this color so users can identify the
   * action at a glance. Pick brand-accurate hues only — random
   * tints are noise and clash with the calm palette.
   */
  tone?: string;
  /** Convert raw args (everything after `/cmd `) into tool args JSON. */
  parseArgs: (rawArgs: string) => SlashArgsResult;
};

/**
 * Display-only entry — used by SlashAutocomplete + formatHelp to
 * show meta-commands (/github, /whatsapp, /help) alongside the
 * catalog. Meta-commands have no `parseArgs` because the dispatcher
 * special-cases them; they DO need names + descriptions + tones for
 * the user-facing surfaces.
 */
export type SlashDisplayEntry = {
  command: string;
  description: string;
  tone?: string;
};

// Hardcoded URL for /radio. Picked a curated lofi-radio search rather
// than a single video so the user gets fresh content if Anthropic's
// "Claude FM" link ever rotates. Plain YouTube search ranks the
// long-running 24/7 lofi streams first.
const CLAUDE_FM_URL =
  "https://www.youtube.com/results?search_query=lofi+hip+hop+radio";

const DOCS_URL = "https://inariwatch.com/docs";

/**
 * Path-absolute check that doesn't depend on the runtime's `path.isAbsolute`
 * (the dispatcher runs in both Tauri webview and jsdom). Accepts the two
 * shapes the slash users actually type:
 *   - Windows: `C:\…`, `D:/…` (drive letter + `:` + separator)
 *   - POSIX:   `/…`
 */
function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/");
}

/**
 * The full catalog. Order is the order shown in the palette.
 *
 * Tools used:
 * - `desktop.open_in_editor` for `/code`
 * - `desktop.open_url`       for `/radio`, `/url`, `/docs`
 * - `setup.install_capture`  for `/install`
 * - `comm.send_telegram`     for `/telegram`
 * - `comm.send_slack`        for `/slack`
 */
export const SLASH_CATALOG: readonly SlashCatalogEntry[] = [
  {
    command: "radio",
    description: "Play Claude FM lofi radio in your browser",
    toolName: "desktop.open_url",
    // YouTube red — softened so it doesn't punch on the dark surface.
    tone: "#FF4D4F",
    parseArgs: () => ({ args: { url: CLAUDE_FM_URL } }),
  },
  {
    command: "code",
    description: "Open a file in your editor — `/code path[:line]`",
    toolName: "desktop.open_in_editor",
    parseArgs: (rest) => {
      if (!rest.trim()) {
        return { error: "Path required. Try `/code src/lib.rs` or `/code src/lib.rs:42`." };
      }
      // Parse `path` or `path:line`. The line suffix is optional and
      // forwarded as a 1-based integer (matches open_in_editor's
      // params_schema).
      const match = rest.match(/^(.+?)(?::(\d+))?$/);
      if (!match) return { error: "Expected `path` or `path:line`." };
      const path = match[1].trim();
      if (!path) return { error: "Path cannot be empty." };
      const lineRaw = match[2];
      if (lineRaw === undefined) {
        return { args: { path } };
      }
      const line = Number.parseInt(lineRaw, 10);
      if (!Number.isFinite(line) || line < 1) {
        return { error: "Line must be a positive integer (1-based)." };
      }
      return { args: { path, line } };
    },
  },
  {
    command: "url",
    description: "Open an https URL in your default browser — `/url https://...`",
    toolName: "desktop.open_url",
    parseArgs: (rest) => {
      const url = rest.trim();
      if (!url) return { error: "URL required. Try `/url https://example.com`." };
      if (!/^https?:\/\//i.test(url)) {
        return { error: "URL must start with http:// or https://." };
      }
      return { args: { url } };
    },
  },
  {
    command: "finder",
    description: "Open a folder in the OS file manager — `/finder <path>`",
    toolName: "desktop.open_finder",
    parseArgs: (rest) => {
      const path = rest.trim();
      if (!path) {
        return { error: "Path required. Try `/finder ./exports` or `/finder ~/Downloads`." };
      }
      return { args: { path } };
    },
  },
  {
    command: "docs",
    description: "Open the InariWatch docs",
    toolName: "desktop.open_url",
    parseArgs: () => ({ args: { url: DOCS_URL } }),
  },
  {
    // `/open` is a more permissive sibling of `/code` — same backend
    // tool, but the description leans general-purpose ("open a file")
    // because Tauri's `open_path` dispatches to the OS default-app
    // handler. For a `.ts` that's the editor; for a `.pdf` it's the
    // PDF viewer. /code is for "I'm editing this"; /open is "show me
    // this in whatever opens it".
    command: "open",
    description: "Open a file or folder with the OS default app — `/open <path>`",
    toolName: "desktop.open_in_editor",
    parseArgs: (rest) => {
      const path = rest.trim();
      if (!path) {
        return { error: "Path required. Try `/open ./README.md` or `/open ~/Downloads/report.pdf`." };
      }
      return { args: { path } };
    },
  },
  {
    // `/install <path> [--project=<id>]` — wraps `setup.install_capture`.
    // When `--project` is omitted the Rust tool auto-resolves from the
    // pending WizardStore (web "Add Project" click). On a cold install
    // with no wizard open and no flag, the tool errors with an
    // actionable hint that the dispatcher surfaces verbatim.
    command: "install",
    description: "Install @inariwatch/capture into a local repo — `/install <absolute path> [--project=<id>]`",
    toolName: "setup.install_capture",
    parseArgs: (rest) => {
      const trimmed = rest.trim();
      if (!trimmed) {
        return {
          error: "Path required. Try `/install C:\\code\\my-app` (absolute path to your project root).",
        };
      }
      // Extract optional `--project=<id>` flag — anywhere in the input.
      const projectMatch = trimmed.match(/(^|\s)--project=(\S+)(\s|$)/);
      const projectId = projectMatch?.[2];
      const path = projectMatch
        ? trimmed.replace(projectMatch[0], " ").trim()
        : trimmed;
      if (!path) {
        return {
          error: "Path required. `--project=<id>` is optional; the repo path is not.",
        };
      }
      if (!isAbsolutePath(path)) {
        return {
          error: "Repo path must be absolute (e.g. `C:\\code\\my-app` or `/home/me/api`).",
        };
      }
      // project_id is intentionally optional — the Rust tool will
      // auto-resolve from a pending wizard when omitted, and surface a
      // clear error when there's nothing to resolve. Don't pre-validate
      // its shape here: the canonical authority is the tool.
      return {
        args: projectId
          ? { repo_path: path, project_id: projectId }
          : { repo_path: path },
      };
    },
  },
  {
    // `/telegram <chat_id> <message>` — wraps `comm.send_telegram`. The
    // chat_id is forwarded as a string; the Rust tool accepts both
    // `@channelusername` and numeric ids in the same field. Confirm
    // bypass: typing the message body IS the consent (same logic as
    // /whatsapp).
    command: "telegram",
    description: "Send a Telegram message — `/telegram <chat_id> <message>`",
    toolName: "comm.send_telegram",
    // Telegram brand blue.
    tone: "#229ED9",
    parseArgs: parseTelegramOrSlackArgs("telegram", (chatId, text) => ({
      chat_id: chatId,
      text,
    })),
  },
  {
    // Short alias for `/telegram`. Same toolName + parseArgs so both
    // forms resolve identically; declared after `telegram` so the
    // help list shows the canonical form first.
    command: "tg",
    description: "Alias of `/telegram` — `/tg <chat_id> <message>`",
    toolName: "comm.send_telegram",
    tone: "#229ED9",
    parseArgs: parseTelegramOrSlackArgs("telegram", (chatId, text) => ({
      chat_id: chatId,
      text,
    })),
  },
  {
    command: "slack",
    description: "Post to a Slack channel — `/slack <channel|#name|C…> <message>`",
    toolName: "comm.send_slack",
    // Slack aubergine.
    tone: "#4A154B",
    parseArgs: parseTelegramOrSlackArgs("slack", (channel, text) => ({
      channel,
      text,
    })),
  },
];

/**
 * Shared parser for the comm.* slashes (`/telegram` + `/slack`): split
 * on the first whitespace into a recipient/channel + message body.
 * Empty recipient OR empty body surfaces a per-command hint.
 */
function parseTelegramOrSlackArgs(
  command: "telegram" | "slack",
  build: (recipient: string, text: string) => Record<string, unknown>,
): (rest: string) => SlashArgsResult {
  const recipientLabel = command === "telegram" ? "chat_id" : "channel";
  const example =
    command === "telegram"
      ? "/telegram @inari_oncall Heads up: deploy degraded"
      : "/slack #alerts Deploy is degraded";
  return (rest: string) => {
    const trimmed = rest.trim();
    if (!trimmed) {
      return {
        error: `Missing arguments. Try \`${example}\`.`,
      };
    }
    const m = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
    if (!m) {
      return {
        error: `Missing message body. Try \`${example}\`.`,
      };
    }
    const recipient = m[1];
    const text = m[2].trim();
    if (!text) {
      return {
        error: `Empty message body. Provide a non-empty message after the ${recipientLabel}.`,
      };
    }
    return { args: build(recipient, text) };
  };
}

/**
 * Look up a slash command by its name. Returns `null` for unknown
 * commands so the caller can show "Unknown command — try /?"
 * inline rather than passing junk to the dispatcher.
 */
export function findSlashCommand(command: string): SlashCatalogEntry | null {
  const lower = command.toLowerCase();
  return SLASH_CATALOG.find((entry) => entry.command === lower) ?? null;
}

/**
 * Meta-commands shown in the autocomplete + /help. They DON'T have
 * `parseArgs` because the slash dispatcher special-cases them
 * (GITHUB_COMMANDS / WHATSAPP_COMMANDS / META_COMMANDS sets), but
 * they DO need to be discoverable when the user types `/`.
 *
 * Brand-color tones picked to match each service's identity at a
 * glance — green for WhatsApp, cream for GitHub (matching Inari's
 * accent because GitHub's monochrome palette doesn't pop on a dark
 * surface). /help is left toneless because it's a pure utility.
 */
export const SLASH_META: readonly SlashDisplayEntry[] = [
  {
    command: "github",
    description: "Open the active repo on GitHub. Subcommands: prs, issues, actions, releases",
    // GitHub's brand is monochrome — use the cream accent so the
    // /<command> still pops above the muted catalog entries without
    // looking out of place against the dark UI.
    tone: "var(--accent)",
  },
  {
    command: "whatsapp",
    description: "Send via paired WhatsApp — `/whatsapp <name|+E164> <message>`",
    // WhatsApp brand green.
    tone: "#25D366",
  },
  // ── Cloud workspace queries (structured render — see slash/handlers.ts) ──
  // These don't go through the catalog's tool-dispatch path (their
  // output is rendered as a markdown table/card, not just a one-line
  // summary). They live in SLASH_META so /help + the autocomplete
  // surface them, while the actual dispatch lives in
  // `slash/handlers.ts::STRUCTURED_HANDLERS`.
  {
    command: "projects",
    description: "List your projects with active integrations — `/projects [--integration=<svc>]`",
  },
  {
    command: "digest",
    description: "Workspace digest — 24h alerts, uptime, on-call (no args)",
  },
  {
    command: "health",
    description: "Health snapshot of one project — `/health <project_id>`",
  },
  {
    command: "alerts",
    description: "Recent alerts — `/alerts [limit]` (default 20, max 100)",
  },
  {
    command: "alert",
    description: "Open a single alert by Inari hash — `/alert <hash>`",
  },
  {
    command: "uptime",
    description: "Uptime monitors across the workspace (no args)",
  },
  {
    command: "oncall",
    description: "Current on-call assignments per project (no args)",
  },
  {
    command: "search",
    description: "Search SO + GitHub + MDN — `/search <error text>`",
  },
  // P0 batch — local-only meta-commands that wrap existing store/IPC
  // primitives. No tones (utility commands, not branded actions).
  {
    command: "new",
    description: "Start a new conversation — clears the current thread",
  },
  {
    command: "clear",
    description: "Clear the current conversation",
  },
  {
    command: "settings",
    description: "Open Settings",
  },
  {
    command: "audit",
    description: "Open the audit log",
  },
  {
    command: "devices",
    description: "Open Settings → Channels (paired phones + devices)",
  },
  {
    command: "theme",
    description: "Switch theme — `/theme <light|dark|system>`",
  },
  {
    command: "voice",
    description: "Toggle voice input — `/voice <on|off>`",
  },
  {
    command: "help",
    description: "Show this list (alias: `/?`)",
    // Toneless — pure utility, doesn't need brand identity.
  },
  // Inari Live V1 — Session 5 conversation lifecycle commands. They
  // require an open conversation context (`SlashCtx.conversationId`);
  // free-chat invocations render an "open a conversation first" note.
  // Tones omitted — these are utility/lifecycle, not brand actions.
  {
    command: "snooze",
    description: "Snooze conversation — `/snooze 2h`, `/snooze 5pm`, `/snooze tomorrow`",
  },
  {
    command: "resolve",
    description: "Mark conversation resolved — `/resolve [reason]`",
  },
  {
    command: "reopen",
    description: "Reopen a resolved conversation",
  },
  {
    command: "archive",
    description: "Archive conversation",
  },
  {
    command: "ack",
    description: "Acknowledge anchor alert — `/ack [reason]`",
  },
  {
    command: "silence",
    description: "Silence anchor alert — `/silence 1h | 24h | 7d | forever`",
  },
  {
    command: "escalate",
    description: "Escalate to on-call — `/escalate [@user]`",
  },
  {
    command: "summarize",
    description: "AI-summarise the conversation so far",
  },
  {
    command: "export",
    description: "Export conversation — `/export md|json`",
  },
  {
    command: "witness",
    description: "Witness chain — `/witness verify` or `/witness export`",
  },
  {
    command: "test",
    description: "Inari Guard — `/test <path>` generates tests for a file (e.g. `/test src/lib/auth.ts`)",
  },
];

/**
 * Combined display list for the autocomplete + /help. Single source
 * of truth for "every slash command the user can type". Iteration
 * order = catalog first, meta after — matches what's most common
 * (catalog) appearing at the top of the dropdown.
 */
export const SLASH_DISPLAY: readonly SlashDisplayEntry[] = [
  ...SLASH_CATALOG.map(
    (e): SlashDisplayEntry => ({
      command: e.command,
      description: e.description,
      tone: e.tone,
    }),
  ),
  ...SLASH_META,
];
