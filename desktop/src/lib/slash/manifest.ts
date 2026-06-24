/**
 * Slash-command manifest — the canonical user-facing catalog consumed
 * by Phase 2's AI autocomplete (and any future surface that needs to
 * enumerate every command with its arg schema).
 *
 * Per `INARI_LIVE_PURE_SLASH_PLAN.md`, the autocomplete LLM gets this
 * manifest in its system prompt and translates natural-language queries
 * into concrete slash invocations. The richer the args schema here, the
 * less the model has to guess.
 *
 * ## Drift safety
 *
 * Every entry's `handler` is the function name in `slash-dispatch.ts`
 * (or the catalog entry's `command` for tool-routed commands). A
 * regression test (`__tests__/manifest.test.ts`) asserts that:
 *   1. every dispatcher-wired command appears in this manifest, and
 *   2. every manifest entry has a working dispatch path.
 *
 * If you add a slash command, update this manifest in the same commit.
 *
 * ## Scope
 *
 * Only **user-facing** commands belong here. Internal tools that the
 * LLM never invokes directly (e.g. `local.read_file`, `desktop.notify`)
 * stay off the menu — they're sandbox primitives, not chat commands.
 */

/**
 * Argument shape — exposed to Phase 2's autocomplete so the LLM knows
 * what to fill in. `type` drives the dropdown widget: `enum` shows the
 * declared values, `path` triggers fs autocomplete (Phase 4), `number`
 * + `string` are plain inputs.
 */
export interface SlashArg {
  /** Arg name (positional or flag — see `flag` field). */
  name: string;
  /** Value type. Drives autocomplete widget + validation. */
  type: "string" | "number" | "enum" | "path";
  /** When true, the command refuses to dispatch without this arg. */
  required: boolean;
  /** One-line user-facing description shown in the autocomplete dropdown. */
  description: string;
  /** Closed set of valid values for `type: "enum"`. Ignored otherwise. */
  enumValues?: string[];
  /**
   * When set, this arg is invoked as `--<flag>=<value>` rather than
   * positionally. Used for the optional filter args on `/projects` etc.
   * Omitted = positional.
   */
  flag?: string;
}

/**
 * Categorical bucket — drives the per-row icon in the autocomplete
 * dropdown (Phase 4.5 visual polish). Categorisation here is
 * deliberately coarse:
 *
 *   - `query` — read-only data fetches (projects, alerts, uptime, …).
 *   - `action` — mutating / side-effect commands (install, send a
 *     message, lifecycle transitions like resolve/snooze/archive).
 *   - `nav` — open something elsewhere (a file in the editor, a URL
 *     in the browser, a repo on GitHub).
 *   - `meta` — UI / config (settings, theme, help, clear).
 *
 * Omitted on entries where the category isn't obvious — the dropdown
 * falls through to a neutral fallback icon for those.
 */
export type SlashCategory = "query" | "action" | "nav" | "meta";

/**
 * Manifest entry — one per user-facing slash command. Aliases (e.g.
 * `/gh` for `/github`) get their own entries so the autocomplete can
 * surface either form.
 */
export interface SlashCommand {
  /** User-typed command name WITH leading slash, e.g. `"/projects"`. */
  name: string;
  /** One-line description shown in `/help` + the autocomplete dropdown. */
  description: string;
  /** Positional + flag args, in display order. Can be empty. */
  args: SlashArg[];
  /**
   * Logical handler identifier. For tool-routed commands this is the
   * catalog `command` field. For special-cased commands it's the
   * dispatcher function name. Used by the drift test to verify each
   * entry has a working path.
   */
  handler: string;
  /**
   * 2-3 invocation examples for the autocomplete UI to show as hints.
   * Should be realistic — these may be surfaced verbatim when the LLM
   * has low confidence and falls back to "did you mean...".
   */
  examples: string[];
  /**
   * Optional brand-color hex/CSS-var for the autocomplete row. Mirrors
   * the existing `tone` field in `slash-catalog.ts` so an aliased entry
   * can carry the same brand identity.
   */
  tone?: string;
  /**
   * Coarse category for the per-row icon in the autocomplete dropdown.
   * Optional — entries without a category get a neutral fallback icon.
   * See [`SlashCategory`] for the buckets.
   */
  category?: SlashCategory;
}

// ── Argument schema helpers (kept inline to avoid drift) ────────────────────

const ARG_PROJECT_INTEGRATION: SlashArg = {
  name: "integration",
  type: "enum",
  required: false,
  description: "Filter to projects where this integration is active.",
  enumValues: [
    "capture",
    "github",
    "vercel",
    "agent",
    "datadog",
    "expo",
    "sentry",
  ],
  flag: "integration",
};

const ARG_REPO_PATH: SlashArg = {
  name: "path",
  type: "path",
  required: true,
  description: "Absolute path to the local repository root.",
};

const ARG_PROJECT_ID: SlashArg = {
  name: "project_id",
  type: "string",
  required: true,
  description: "Project UUID — get one with `/projects` first if you don't have it.",
};

const ARG_ALERT_LIMIT: SlashArg = {
  name: "limit",
  type: "number",
  required: false,
  description: "How many alerts to fetch (default 20, max 100).",
};

const ARG_ALERT_HASH: SlashArg = {
  name: "hash",
  type: "string",
  required: true,
  description: "Inari hash — the 16-hex suffix of an `inari:alert:…` reference.",
};

const ARG_SEARCH_QUERY: SlashArg = {
  name: "query",
  type: "string",
  required: true,
  description: "Error text or stack-trace snippet to look up across SO/GitHub/MDN.",
};

const ARG_RECIPIENT_PHONE: SlashArg = {
  name: "recipient",
  type: "string",
  required: true,
  description: "WhatsApp display name (paired) or raw E.164 phone (`+5215512345678`).",
};

const ARG_MESSAGE_BODY: SlashArg = {
  name: "message",
  type: "string",
  required: true,
  description: "Message body.",
};

const ARG_TELEGRAM_CHAT: SlashArg = {
  name: "chat_id",
  type: "string",
  required: true,
  description: "Telegram chat id (numeric) or `@channelusername`.",
};

const ARG_SLACK_CHANNEL: SlashArg = {
  name: "channel",
  type: "string",
  required: true,
  description: "Slack channel id (`C0123…`) or channel name (`#alerts`).",
};

const ARG_FILE_PATH: SlashArg = {
  name: "path",
  type: "path",
  required: true,
  description: "Repo-relative file path.",
};

const ARG_FILE_PATH_OPT_LINE: SlashArg = {
  name: "line",
  type: "number",
  required: false,
  description: "Optional 1-based line number — suffix as `path:line`.",
};

const ARG_URL_REQUIRED: SlashArg = {
  name: "url",
  type: "string",
  required: true,
  description: "https URL to open.",
};

const ARG_GITHUB_SUB: SlashArg = {
  name: "section",
  type: "enum",
  required: false,
  description: "Repo section. Omit for the repo home.",
  enumValues: ["prs", "issues", "actions", "releases"],
};

const ARG_THEME_MODE: SlashArg = {
  name: "mode",
  type: "enum",
  required: false,
  description: "Theme mode. Omit to print the current value.",
  enumValues: ["light", "dark", "system"],
};

const ARG_VOICE_TOGGLE: SlashArg = {
  name: "state",
  type: "enum",
  required: false,
  description: "Toggle voice input. Omit to print the current value.",
  enumValues: ["on", "off"],
};

const ARG_SNOOZE_DURATION: SlashArg = {
  name: "until",
  type: "string",
  required: true,
  description: "Relative (`2h`, `30m`) or absolute (`5pm`, `tomorrow`).",
};

const ARG_RESOLVE_REASON: SlashArg = {
  name: "reason",
  type: "string",
  required: false,
  description: "Optional one-line resolution summary.",
};

const ARG_SILENCE_DURATION: SlashArg = {
  name: "duration",
  type: "enum",
  required: true,
  description: "Silence window or `forever`.",
  enumValues: ["1h", "24h", "7d", "forever"],
};

const ARG_EXPORT_FORMAT: SlashArg = {
  name: "format",
  type: "enum",
  required: false,
  description: "Export format. Defaults to `md`.",
  enumValues: ["md", "json"],
};

const ARG_WITNESS_SUB: SlashArg = {
  name: "subcommand",
  type: "enum",
  required: false,
  description: "Witness operation. Defaults to `verify`.",
  enumValues: ["verify", "export"],
};

const ARG_HELP_TARGET: SlashArg = {
  name: "command",
  type: "string",
  required: false,
  description: "Optional command name — omit for the full list.",
};

const ARG_FINDER_PATH: SlashArg = {
  name: "path",
  type: "path",
  required: true,
  description: "Folder or file to surface in the OS file manager.",
};

// ── Canonical list ──────────────────────────────────────────────────────────
//
// Order: workspace queries first (most common in monitoring flow), then
// alert ops, then comms, then editor-side niceties, then meta. The
// autocomplete preserves this order when confidences tie, so high-value
// commands surface first.

export const SLASH_MANIFEST: readonly SlashCommand[] = [
  // ── Workspace queries (cloud read-only) ───────────────────────────────────
  {
    name: "/projects",
    description: "List projects in your workspace with active integrations.",
    args: [ARG_PROJECT_INTEGRATION],
    handler: "projects",
    examples: [
      "/projects",
      "/projects --integration=capture",
      "/projects --integration=vercel",
    ],
    category: "query",
  },
  {
    name: "/digest",
    description: "Aggregate workspace summary — 24h alerts, uptime, on-call.",
    args: [],
    handler: "digest",
    examples: ["/digest"],
    category: "query",
  },
  {
    name: "/health",
    description: "Health snapshot of one project (alerts, uptime, integrations).",
    args: [ARG_PROJECT_ID],
    handler: "health",
    examples: ["/health 0e8a9c1a-…"],
    category: "query",
  },
  {
    name: "/alerts",
    description: "Recent alerts across the workspace.",
    args: [ARG_ALERT_LIMIT],
    handler: "alerts",
    examples: ["/alerts", "/alerts 50"],
    category: "query",
  },
  {
    name: "/alert",
    description: "Open a single alert by its Inari hash.",
    args: [ARG_ALERT_HASH],
    handler: "alert",
    examples: ["/alert 1a2b3c4d5e6f7890"],
    category: "query",
  },
  {
    name: "/fix",
    description: "Trigger AI remediation for an alert — `/fix <hash>` (suspends if omitted).",
    args: [ARG_ALERT_HASH],
    handler: "fix",
    examples: ["/fix 1a2b3c4d5e6f7890", "/fix"],
    category: "action",
  },
  {
    name: "/uptime",
    description: "Uptime monitors — which are up, which are down.",
    args: [],
    handler: "uptime",
    examples: ["/uptime"],
    category: "query",
  },
  {
    name: "/oncall",
    description: "Current on-call assignments per project.",
    args: [],
    handler: "oncall",
    examples: ["/oncall"],
    category: "query",
  },

  // ── Setup / installation ──────────────────────────────────────────────────
  {
    name: "/install",
    description: "Install `@inariwatch/capture` into a local repo.",
    args: [ARG_REPO_PATH],
    handler: "install",
    examples: ["/install C:\\Users\\jesus\\projects\\my-app", "/install /home/me/api"],
    category: "action",
  },

  // ── Search ────────────────────────────────────────────────────────────────
  {
    name: "/search",
    description: "Search SO + GitHub Issues + MDN for an error string.",
    args: [ARG_SEARCH_QUERY],
    handler: "search",
    examples: [
      "/search TypeError: Cannot read properties of undefined",
      "/search EADDRINUSE",
    ],
    category: "query",
  },

  // ── Communications (Confirm-default tools) ────────────────────────────────
  {
    name: "/whatsapp",
    description: "Send via paired WhatsApp — display name or raw +E.164.",
    args: [ARG_RECIPIENT_PHONE, ARG_MESSAGE_BODY],
    handler: "whatsapp",
    examples: [
      "/whatsapp Jose On call test",
      "/whatsapp +5215512345678 Heads up: prod alert",
    ],
    tone: "#25D366",
    category: "action",
  },
  {
    name: "/wa",
    description: "Alias of `/whatsapp`.",
    args: [ARG_RECIPIENT_PHONE, ARG_MESSAGE_BODY],
    handler: "whatsapp",
    examples: ["/wa Jose Quick ping"],
    tone: "#25D366",
    category: "action",
  },
  {
    name: "/telegram",
    description: "Send a Telegram message via the paired bot.",
    args: [ARG_TELEGRAM_CHAT, ARG_MESSAGE_BODY],
    handler: "telegram",
    examples: ["/telegram @inari_oncall Heads up", "/telegram 123456789 Hi"],
    tone: "#229ED9",
    category: "action",
  },
  {
    name: "/tg",
    description: "Alias of `/telegram`.",
    args: [ARG_TELEGRAM_CHAT, ARG_MESSAGE_BODY],
    handler: "telegram",
    examples: ["/tg @inari_oncall Heads up"],
    tone: "#229ED9",
    category: "action",
  },
  {
    name: "/slack",
    description: "Post to a Slack channel via the paired workspace bot.",
    args: [ARG_SLACK_CHANNEL, ARG_MESSAGE_BODY],
    handler: "slack",
    examples: ["/slack #alerts Deploy is degraded", "/slack C012ABC Quick check"],
    tone: "#4A154B",
    category: "action",
  },

  // ── Editor / OS niceties ──────────────────────────────────────────────────
  {
    name: "/code",
    description: "Open a file in the default editor — `path[:line]`.",
    args: [ARG_FILE_PATH, ARG_FILE_PATH_OPT_LINE],
    handler: "code",
    examples: ["/code src/lib.rs", "/code src/lib.rs:42"],
    category: "nav",
  },
  {
    name: "/open",
    description: "Open a file or folder with the OS default app.",
    args: [ARG_FILE_PATH],
    handler: "open",
    examples: ["/open ./README.md", "/open ~/Downloads/report.pdf"],
    category: "nav",
  },
  {
    name: "/finder",
    description: "Open a folder in the OS file manager.",
    args: [ARG_FINDER_PATH],
    handler: "finder",
    examples: ["/finder ./exports", "/finder ~/Downloads"],
    category: "nav",
  },
  {
    name: "/url",
    description: "Open an https URL in your default browser.",
    args: [ARG_URL_REQUIRED],
    handler: "url",
    examples: ["/url https://app.inariwatch.com"],
    category: "nav",
  },
  {
    name: "/docs",
    description: "Open the InariWatch docs.",
    args: [],
    handler: "docs",
    examples: ["/docs"],
    category: "nav",
  },
  {
    name: "/radio",
    description: "Play Claude FM lofi radio in your browser.",
    args: [],
    handler: "radio",
    examples: ["/radio"],
    tone: "#FF4D4F",
    category: "nav",
  },
  {
    name: "/github",
    description: "Open the active repo on GitHub.",
    args: [ARG_GITHUB_SUB],
    handler: "github",
    examples: ["/github", "/github prs", "/github actions"],
    tone: "var(--accent)",
    category: "nav",
  },
  {
    name: "/gh",
    description: "Alias of `/github`.",
    args: [ARG_GITHUB_SUB],
    handler: "github",
    examples: ["/gh prs"],
    tone: "var(--accent)",
    category: "nav",
  },

  // ── Inari Guard test generation ───────────────────────────────────────────
  {
    name: "/test",
    description: "Inari Guard — generate tests for a file in the active project.",
    args: [
      {
        name: "path",
        type: "path",
        required: true,
        description: "Repo-relative path to the file under test.",
      },
    ],
    handler: "test",
    examples: ["/test src/lib/auth.ts", "/test src/components/Login.tsx"],
    category: "action",
  },

  // ── Conversation lifecycle (need open conversation) ───────────────────────
  {
    name: "/snooze",
    description: "Snooze the open conversation until a relative or absolute time.",
    args: [ARG_SNOOZE_DURATION],
    handler: "snooze",
    examples: ["/snooze 2h", "/snooze 5pm", "/snooze tomorrow"],
    category: "action",
  },
  {
    name: "/resolve",
    description: "Mark the open conversation resolved.",
    args: [ARG_RESOLVE_REASON],
    handler: "resolve",
    examples: ["/resolve", "/resolve fixed in #1234"],
    category: "action",
  },
  {
    name: "/reopen",
    description: "Reopen a resolved conversation.",
    args: [],
    handler: "reopen",
    examples: ["/reopen"],
    category: "action",
  },
  {
    name: "/archive",
    description: "Archive the open conversation.",
    args: [],
    handler: "archive",
    examples: ["/archive"],
    category: "action",
  },
  {
    name: "/ack",
    description: "Acknowledge the anchor alert on the open conversation.",
    args: [ARG_RESOLVE_REASON],
    handler: "ack",
    examples: ["/ack", "/ack looking into it"],
    category: "action",
  },
  {
    name: "/silence",
    description: "Silence the anchor alert.",
    args: [ARG_SILENCE_DURATION],
    handler: "silence",
    examples: ["/silence 1h", "/silence forever"],
    category: "action",
  },
  {
    name: "/escalate",
    description: "Escalate the conversation to on-call.",
    args: [
      {
        name: "user",
        type: "string",
        required: false,
        description: "Optional `@user` to escalate to specifically.",
      },
    ],
    handler: "escalate",
    examples: ["/escalate", "/escalate @jane"],
    category: "action",
  },
  {
    name: "/summarize",
    description: "AI-summarise the conversation so far.",
    args: [],
    handler: "summarize",
    examples: ["/summarize"],
    category: "action",
  },
  {
    name: "/export",
    description: "Export the conversation as Markdown or JSON.",
    args: [ARG_EXPORT_FORMAT],
    handler: "export",
    examples: ["/export", "/export json"],
    category: "action",
  },
  {
    name: "/witness",
    description: "Verify or export the Witness chain for the conversation.",
    args: [ARG_WITNESS_SUB],
    handler: "witness",
    examples: ["/witness", "/witness verify", "/witness export"],
    category: "action",
  },

  // ── Meta (no tool, local-only) ────────────────────────────────────────────
  {
    name: "/help",
    description: "Show the full slash-command list (alias: `/?`).",
    args: [ARG_HELP_TARGET],
    handler: "help",
    examples: ["/help", "/help projects"],
    category: "meta",
  },
  {
    name: "/?",
    description: "Alias of `/help`.",
    args: [ARG_HELP_TARGET],
    handler: "help",
    examples: ["/?"],
    category: "meta",
  },
  {
    name: "/new",
    description: "Start a new conversation.",
    args: [],
    handler: "new",
    examples: ["/new"],
    category: "meta",
  },
  {
    name: "/clear",
    description: "Clear the current conversation.",
    args: [],
    handler: "clear",
    examples: ["/clear"],
    category: "meta",
  },
  {
    name: "/settings",
    description: "Open Settings.",
    args: [],
    handler: "settings",
    examples: ["/settings"],
    category: "meta",
  },
  {
    name: "/audit",
    description: "Open the audit log.",
    args: [],
    handler: "audit",
    examples: ["/audit"],
    category: "meta",
  },
  {
    name: "/devices",
    description: "Open Settings → Channels (paired phones + devices).",
    args: [],
    handler: "devices",
    examples: ["/devices"],
    category: "meta",
  },
  {
    name: "/theme",
    description: "Switch the theme.",
    args: [ARG_THEME_MODE],
    handler: "theme",
    examples: ["/theme", "/theme light", "/theme dark"],
    category: "meta",
  },
  {
    name: "/voice",
    description: "Toggle voice input.",
    args: [ARG_VOICE_TOGGLE],
    handler: "voice",
    examples: ["/voice", "/voice on", "/voice off"],
    category: "meta",
  },
];

/**
 * Lookup helper — returns the manifest entry for a typed command
 * (with or without leading `/`). Case-insensitive on the command name.
 * Returns `null` for unknown commands so the autocomplete can fall
 * through to fuzzy match.
 */
export function findManifestEntry(command: string): SlashCommand | null {
  const trimmed = command.startsWith("/") ? command : `/${command}`;
  const lower = trimmed.toLowerCase();
  return SLASH_MANIFEST.find((entry) => entry.name.toLowerCase() === lower) ?? null;
}

/**
 * Phase 4.5 — look up a command's `category` from the canonical
 * manifest. Used by the autocomplete dropdown to pick an icon for
 * each row. Returns `undefined` for unknown commands; the caller is
 * expected to fall back to a neutral icon.
 *
 * Accepts the command with OR without a leading `/` — matches the
 * `findManifestEntry` ergonomics.
 */
export function categoryOf(command: string): SlashCategory | undefined {
  return findManifestEntry(command)?.category;
}

/**
 * Compact serializer for the Phase 2 autocomplete prompt. Drops the
 * `examples` array (the LLM derives them from `args.description`) and
 * the `tone` field (UI-only) so the payload stays under the 3K-token
 * cap mentioned in the plan.
 */
export function serializeManifestForPrompt(): string {
  const compact = SLASH_MANIFEST.map((entry) => ({
    name: entry.name,
    description: entry.description,
    args: entry.args.map((arg) => ({
      name: arg.name,
      type: arg.type,
      required: arg.required,
      description: arg.description,
      ...(arg.enumValues ? { enumValues: arg.enumValues } : {}),
      ...(arg.flag ? { flag: arg.flag } : {}),
    })),
  }));
  return JSON.stringify(compact);
}
