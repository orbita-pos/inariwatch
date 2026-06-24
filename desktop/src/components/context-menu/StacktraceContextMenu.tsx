import { useCallback, useMemo } from "react";

import { useChat } from "@/lib/store/chat";
import type { StacktraceLocation } from "@/lib/stacktrace";
import { desktopToolConfirm } from "@/lib/tool-invoke-ipc";

import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

export interface StacktraceContextMenuProps {
  /** The location captured from the surrounding text. */
  location: StacktraceLocation;
  /** Optional alert id so the prefill can attach turn context. */
  alertId?: string;
  /** Test seam — defaults to the real `desktop_tool_confirm`. */
  invokeConfirm?: typeof desktopToolConfirm;
  /** Test seam — defaults to `navigator.clipboard.writeText`. */
  copyToClipboard?: (text: string) => Promise<void>;
  testId?: string;
  children: React.ReactNode;
}

/**
 * Preset right-click menu for a parsed stacktrace location. Items:
 *
 * - **Open in Editor** — `desktop_tool_confirm("desktop.open_in_editor", ...)`
 *   with `session_id = "ambient-context"` so the audit log can
 *   distinguish chat-driven from ambient-driven invocations.
 * - **Copy path** — copies the path string only, no line/col.
 * - **Fix with AI** — populates the chat input with a prefilled
 *   prompt + focuses the input.
 * - **Investigate** — same handler, different copy.
 */
export function StacktraceContextMenu({
  location,
  alertId,
  invokeConfirm = desktopToolConfirm,
  copyToClipboard,
  testId,
  children,
}: StacktraceContextMenuProps) {
  const setInputValue = useChat((s) => s.setInputValue);
  const startConversation = useChat((s) => s.startConversation);

  const onOpenInEditor = useCallback(async () => {
    try {
      await invokeConfirm(
        "desktop.open_in_editor",
        location.col !== undefined
          ? { path: location.file, line: location.line }
          : { path: location.file, line: location.line },
        "ambient-context",
      );
    } catch (e) {
      console.warn("[stacktrace] open_in_editor failed", e);
    }
  }, [invokeConfirm, location]);

  const onCopyPath = useCallback(async () => {
    try {
      const writer =
        copyToClipboard ??
        (async (text: string) => {
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            await navigator.clipboard.writeText(text);
          }
        });
      await writer(location.file);
    } catch (e) {
      console.warn("[stacktrace] copy path failed", e);
    }
  }, [copyToClipboard, location.file]);

  const onPrefill = useCallback(
    (intro: string) => {
      const prefill = `${intro}\n\n\`${location.file}:${location.line}${location.col ? `:${location.col}` : ""}\``;
      setInputValue(prefill);
      startConversation();
    },
    [location, setInputValue, startConversation],
  );

  const items = useMemo<ContextMenuItem[]>(
    () => [
      {
        id: "open-editor",
        label: "Open in Editor",
        onSelect: () => {
          void onOpenInEditor();
        },
      },
      {
        id: "copy-path",
        label: "Copy path",
        onSelect: () => {
          void onCopyPath();
        },
      },
      {
        id: "fix-ai",
        label: "Fix with AI",
        onSelect: () =>
          onPrefill(
            `Fix this stacktrace${alertId ? ` (alert ${alertId})` : ""}:`,
          ),
      },
      {
        id: "investigate",
        label: "Investigate",
        onSelect: () =>
          onPrefill(
            `Investigate this stacktrace${alertId ? ` (alert ${alertId})` : ""}:`,
          ),
      },
    ],
    [alertId, onCopyPath, onOpenInEditor, onPrefill],
  );

  return (
    <ContextMenu items={items} testId={testId} as="span">
      {children}
    </ContextMenu>
  );
}
