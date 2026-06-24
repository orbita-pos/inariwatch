/**
 * S6 — IPC wrappers for the chat-agent tool registry surface.
 *
 * Mirrors `desktop/src-tauri/src/ipc/tool_invoke.rs`. Three commands:
 *
 * - `desktop_tool_invoke`  — run a tool through its `default_permission`
 *                            gate; returns a tagged `InvokeOutcome`.
 * - `desktop_tool_confirm` — re-run after the inline confirm prompt;
 *                            same `InvokeOutcome` shape.
 * - `desktop_tool_catalog` — enumerate the 15 registered tools (cluster
 *                            order: desktop_os → local_exec → comm).
 *
 * Tests prefer to mock at this boundary via
 * `vi.mock("@/lib/tool-invoke-ipc")` so the chat surface ToolCallCard
 * never hits Tauri JSON-RPC.
 */
import { invoke } from "@tauri-apps/api/core";

import type { PermissionLevel } from "@/lib/audit-ui-ipc";

/** Wire shape of a tool entry in the catalog endpoint. Mirrors `ToolMetaDto`. */
export interface ToolMeta {
  name: string;
  description: string;
  /** JSON schema as returned by the registry — wide-shape `unknown`. */
  params_schema: unknown;
  default_permission: PermissionLevel;
}

/** Wire shape of `ToolOutputDto`. */
export interface ToolOutput {
  /** Tool's structured result. Per-tool schema. */
  value: unknown;
  /** Optional human-friendly summary; falls back to JSON pretty-print. */
  summary: string | null;
}

/**
 * Tagged outcome of `desktop_tool_invoke` / `desktop_tool_confirm`.
 *
 * - `output` — tool ran; `invocation_id` keys the audit row + verifier
 *   modal.
 * - `requires_confirm` — `Confirm`-level short-circuit; the chat
 *   surface shows inline `[Confirm] [Cancel]` and re-dispatches via
 *   `desktop_tool_confirm` with the same args.
 * - `denied` — user override or default `Deny`. Frontend renders a
 *   "permission denied" row with a deeplink to Settings → Permissions.
 */
export type InvokeOutcome =
  | {
      kind: "output";
      invocation_id: string;
      output: ToolOutput;
      permission: PermissionLevel;
    }
  | { kind: "requires_confirm"; tool: string; permission: PermissionLevel }
  | { kind: "denied"; tool: string; reason: string };

/**
 * Run a tool through the live registry. The chat surface dispatches
 * this when the LLM emits a `chat_tool_call` daemon-event; the
 * returned outcome drives the ToolCallCard's state machine.
 */
export async function desktopToolInvoke(
  toolName: string,
  args: unknown,
  sessionId: string | null,
): Promise<InvokeOutcome> {
  return invoke<InvokeOutcome>("desktop_tool_invoke", {
    toolName,
    args,
    sessionId,
  });
}

/**
 * Re-dispatch after the inline confirm prompt. The frontend passes
 * the SAME `args` it dispatched the original `_invoke` with — the
 * backend doesn't cache pending invocations, so the chat surface is
 * the source of truth between the prompt and the confirmation.
 */
export async function desktopToolConfirm(
  toolName: string,
  args: unknown,
  sessionId: string | null,
): Promise<InvokeOutcome> {
  return invoke<InvokeOutcome>("desktop_tool_confirm", {
    toolName,
    args,
    sessionId,
  });
}

/**
 * User-typed `/<command>` entry point. Bypasses the `Confirm` gate
 * (the typing IS the consent) but still respects per-tool `Deny`
 * overrides from Settings → Permissions. The audit row records
 * `source = "slash"` so the chain reflects who initiated the invoke.
 *
 * On `Denied`, the backend formats `reason` to point at Settings —
 * the chat surface can render it as-is without needing to know
 * "this came from a slash command" to compose the message.
 */
export async function desktopToolInvokeViaSlash(
  toolName: string,
  args: unknown,
  sessionId: string | null,
): Promise<InvokeOutcome> {
  return invoke<InvokeOutcome>("desktop_tool_invoke_via_slash", {
    toolName,
    args,
    sessionId,
  });
}

/**
 * Enumerate the registered tools. Used at chat-session boot to seed
 * the in-memory mirror that drives the `[verified:…]` chip + the
 * tool-call card's name lookup. The settings UI keeps using
 * `desktop_permission_list` since it also needs override state; this
 * endpoint is intentionally just the static catalog.
 */
export async function desktopToolCatalog(): Promise<ToolMeta[]> {
  // Empty array on failure (jsdom / pre-S6 daemon) so callers don't
  // have to branch on the failure path; the chat surface degrades
  // gracefully to "no tools" — same as a brand-new chat with the
  // catalog suppressed.
  try {
    return await invoke<ToolMeta[]>("desktop_tool_catalog");
  } catch (e) {
    console.info("[tool-invoke-ipc] desktop_tool_catalog unavailable", e);
    return [];
  }
}
