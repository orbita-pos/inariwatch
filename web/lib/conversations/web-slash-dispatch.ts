/**
 * Web-side slash dispatcher for conversation commands.
 *
 * Inari Live V1 Session 5. Parallels the desktop's
 * `desktop/src/lib/slash-dispatch.ts` but adapts to a browser context:
 *   * No Tauri IPC — every command becomes an HTTP call to a
 *     `/api/conversations/...` route.
 *   * Returns a minimal `{ handled, note?, error? }` result so the
 *     conversation pane can render an inline assistant note WITHOUT
 *     persisting it (slash dispatches that change server state already
 *     trigger a `conversation.message` SSE event when applicable).
 *
 * Supported commands (per S5 brief):
 *   /snooze <until>        flexible time parser (5pm, tomorrow, 2h)
 *   /resolve [reason]      mark resolved, optional summary
 *   /reopen                reopen resolved
 *   /ack [reason]          server-side ack on the anchor alert (TODO note)
 *   /silence <duration>    1h, 24h, 7d, forever (TODO note)
 *   /escalate [@user]      escalation engine (TODO note)
 *   /summarize             AI summarises convo so far (TODO note — calls /api/chat)
 *   /export [md|json]      download (TODO note — opens GET endpoint in new tab)
 *   /witness verify        chain verify
 *   /witness export        download chain receipt JSON
 *
 * For commands that don't yet have a dedicated server route in V1 (ack,
 * silence, escalate, summarize, export), the dispatcher renders an
 * "acknowledged — wired in V1.5" assistant note. The state-machine
 * commands (snooze, resolve, reopen, witness) are fully wired today.
 */

import { parseSnoozeUntil } from "./snooze-parser";

export interface SlashResult {
  /** True when the input was recognised as a slash command. */
  handled: boolean;
  /** Inline assistant note rendered in the chat (markdown). */
  note?: string;
  /** Error message — surfaced under the composer. */
  error?: string;
}

interface ParsedSlash {
  command: string;
  args: string;
}

function parse(input: string): ParsedSlash | null {
  if (!input.startsWith("/")) return null;
  const rest = input.slice(1).trimStart();
  const sp = rest.indexOf(" ");
  if (sp === -1) return { command: rest.toLowerCase(), args: "" };
  return {
    command: rest.slice(0, sp).toLowerCase(),
    args:    rest.slice(sp + 1).trim(),
  };
}

export async function dispatchConversationSlash(
  conversationId: string,
  input: string,
): Promise<SlashResult> {
  const parsed = parse(input);
  if (!parsed) return { handled: false };

  switch (parsed.command) {
    case "snooze": {
      const result = parseSnoozeUntil(parsed.args);
      if ("error" in result) return { handled: true, error: result.error };
      const out = await postState(conversationId, {
        state:        "snoozed",
        snoozedUntil: result.until.toISOString(),
      });
      return out.ok
        ? { handled: true, note: `Snoozed until ${result.until.toLocaleString()}.` }
        : { handled: true, error: out.error };
    }

    case "resolve": {
      const out = await postState(conversationId, {
        state:             "resolved",
        resolutionSummary: parsed.args || null,
      });
      return out.ok
        ? { handled: true, note: `Resolved.${parsed.args ? ` ${parsed.args}` : ""}` }
        : { handled: true, error: out.error };
    }

    case "reopen": {
      const out = await postState(conversationId, { state: "active" });
      return out.ok
        ? { handled: true, note: "Reopened." }
        : { handled: true, error: out.error };
    }

    case "archive": {
      const out = await postState(conversationId, { state: "archived" });
      return out.ok
        ? { handled: true, note: "Archived." }
        : { handled: true, error: out.error };
    }

    case "ack":
      return {
        handled: true,
        note:    "Acknowledge wiring lands with the alert-services bridge in V1.5. For now the conversation stays open.",
      };

    case "silence":
      return {
        handled: true,
        note:    "Silence wiring routes through the existing alert-silence service — UI bridge in V1.5.",
      };

    case "escalate":
      return {
        handled: true,
        note:    "Escalation wiring routes through the on-call engine — UI bridge in V1.5.",
      };

    case "summarize":
      return {
        handled: true,
        note:    "Summarize relays to /api/chat with the conversation context — bridge ships in V1.5.",
      };

    case "export": {
      const fmt = parsed.args.trim().toLowerCase();
      if (fmt && fmt !== "md" && fmt !== "json") {
        return { handled: true, error: "Format must be `md` or `json`." };
      }
      return {
        handled: true,
        note:    `Export bridge ships in V1.5. Today the chain receipt is exportable via \`/witness export\`.`,
      };
    }

    case "witness": {
      const sub = parsed.args.trim().toLowerCase();
      if (sub === "verify" || sub === "") {
        return await witnessVerify(conversationId);
      }
      if (sub === "export") {
        // For V1, we just deep-link to the verify endpoint; the user can save the JSON.
        const url = `/api/conversations/${conversationId}/verify`;
        if (typeof window !== "undefined") window.open(url, "_blank");
        return {
          handled: true,
          note:    "Receipt JSON opened in a new tab — save the response to keep a copy.",
        };
      }
      return { handled: true, error: `Unknown /witness subcommand \`${sub}\`. Try \`verify\` or \`export\`.` };
    }

    default:
      return { handled: true, error: `Unknown command \`/${parsed.command}\`.` };
  }
}

interface StateBody {
  state: "active" | "snoozed" | "resolved" | "archived";
  snoozedUntil?: string;
  resolutionSummary?: string | null;
}

async function postState(
  conversationId: string,
  body: StateBody,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/conversations/${conversationId}/state`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: text || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network" };
  }
}

async function witnessVerify(conversationId: string): Promise<SlashResult> {
  try {
    const res = await fetch(`/api/conversations/${conversationId}/verify`, { method: "POST" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { handled: true, error: text || `HTTP ${res.status}` };
    }
    const json = (await res.json()) as {
      ok: boolean;
      totalMessages: number;
      firstBreakAt?: { messageId: string; reason: string } | null;
    };
    if (json.ok) {
      return {
        handled: true,
        note:    `✓ verified · ${json.totalMessages} message${json.totalMessages === 1 ? "" : "s"} chained correctly.`,
      };
    }
    if (json.firstBreakAt?.reason === "missing_hash") {
      return {
        handled: true,
        note:    `⚠ unverifiable · chain not fully populated (legacy row at ${json.firstBreakAt.messageId.slice(0, 8)}).`,
      };
    }
    return {
      handled: true,
      note:    `✗ tampered · break detected at message ${json.firstBreakAt?.messageId.slice(0, 8) ?? "?"}.`,
    };
  } catch (err) {
    return { handled: true, error: err instanceof Error ? err.message : "verify failed" };
  }
}
