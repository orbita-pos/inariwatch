/**
 * Slash-command parser. Pure function, no DOM / IPC / filesystem deps.
 *
 * Usage:
 *   const cmd = parseSlashCommand("/radio");
 *   // → { command: "radio", args: "" }
 *
 *   const cmd = parseSlashCommand("/url https://example.com");
 *   // → { command: "url", args: "https://example.com" }
 *
 *   const cmd = parseSlashCommand("just a normal message");
 *   // → null
 *
 * The catalog (`./slash-catalog.ts`) is what maps `command` → backend
 * tool. This file only does the surface parsing — splitting `/cmd arg
 * arg arg` into `{ command, args }` and rejecting non-slash inputs.
 *
 * Why split parse / catalog / dispatch? Each can be tested in isolation
 * without spinning up a tool registry or Tauri runtime. The dispatcher
 * lives in the chat input handler (DockConversation) which calls the
 * `desktop_tool_invoke_via_slash` IPC.
 */

export type SlashCommand = {
  /** The command name without the leading `/`. Always lowercased. */
  command: string;
  /** Raw rest of the input after the command name, trimmed. May be empty. */
  args: string;
};

/**
 * Parse a string as a slash command. Returns `null` if the input
 * doesn't look like a slash command — caller should treat the input
 * as a normal chat message in that case.
 *
 * Rules:
 * - Must start with `/` (after trimming whitespace).
 * - Command name is `[a-z][a-z0-9_-]*` (lowercased on output).
 * - Anything after the first whitespace is `args`, trimmed.
 * - `/` alone or `/123abc` (digit start) returns null — those are
 *   not valid commands and we want the caller to treat them as
 *   normal text rather than swallowing them.
 */
export function parseSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const rest = trimmed.slice(1);
  if (rest.length === 0) return null;

  // Split on first whitespace.
  const spaceMatch = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!spaceMatch) return null;

  const rawCommand = spaceMatch[1];
  const args = (spaceMatch[2] ?? "").trim();

  // Validate command shape: letter then alphanum/underscore/hyphen.
  // Case-insensitive on input, lowercased on output for case-stable
  // catalog lookup. Reject digit-start so URLs like /1234 (a path)
  // don't get parsed as commands.
  if (!/^[a-z][a-z0-9_-]*$/i.test(rawCommand)) return null;

  return {
    command: rawCommand.toLowerCase(),
    args,
  };
}
