import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Settings as SettingsIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { CommandPalette } from "@/components/CommandPalette";
import { Dialog } from "@/components/ui";
import { DockAlert } from "@/screens/DockAlert";
import { DockConversation } from "@/screens/DockConversation";
import { DockDiff } from "@/screens/DockDiff";
import { DockIdle } from "@/screens/DockIdle";
import { GateRunning } from "@/screens/GateRunning";
import { MainAudit } from "@/screens/main/Audit";
// Inari Live V1 — Session 5 conversation surfaces. Inbox = workspace-level
// conversation list; Conversation = full-thread viewer with SSE sync. Both
// open as overlays (Cmd+B for inbox, in-app row click for conversation).
import { MainInbox } from "@/screens/main/Inbox";
import { MainConversation } from "@/screens/main/Conversation";
import { RecordingsOverlay } from "@/screens/recordings/RecordingsOverlay";
import { PlayerPanel } from "@/screens/PlayerPanel";
import { SearchPanel } from "@/components/search/SearchPanel";
import { Settings } from "@/screens/Settings";
import { installChatStreamDriver } from "@/lib/chat-stream";
import { installGateRunListener } from "@/lib/gate-events";
import { installPrefillListener } from "@/lib/prefill-listener";
import { useChat, type ChatMode } from "@/lib/store/chat";
import { useCommandPalette } from "@/lib/store/commandPalette";
import { useSettings } from "@/lib/store/settings";

/**
 * Chat-first shell. The window is a single chat surface; everything
 * else (audit, inbox, settings, etc.) is reachable through the agent's
 * tool calls or via cmd+, / cmd+k overlays.
 *
 * The chrome at the top is a 40px drag-region titlebar with the Inari
 * diamond mark + label on the left and a settings gear on the right —
 * lifted from the Claude Design comp (2026-05-07 chat-first reframe).
 */
export function MainWindow() {
  const mode = useChat((s) => s.mode);
  const reduce = useReducedMotion();
  const paletteOpen = useCommandPalette((s) => s.open);
  const paletteIntent = useCommandPalette((s) => s.intent);
  const setPaletteOpen = useCommandPalette((s) => s.setOpen);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const setSettingsSection = useSettings((s) => s.setActiveSection);
  const [auditOpen, setAuditOpen] = useState(false);
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Inari Live V1 — Session 5 conversation surfaces. `inboxOpen` opens
  // the workspace conversation list; `activeConversationId` (when set)
  // mounts the conversation viewer over everything else. Click-through
  // closes both back to the chat surface.
  const [inboxOpen, setInboxOpen] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);

  useEffect(() => {
    let unlistenChat: (() => void) | null = null;
    let unlistenGate: (() => void) | null = null;
    let unlistenPrefill: (() => void) | null = null;
    installChatStreamDriver().then((u) => {
      unlistenChat = u;
    });
    installGateRunListener().then((u) => {
      unlistenGate = u;
    });
    installPrefillListener().then((u) => {
      unlistenPrefill = u;
    });
    return () => {
      if (unlistenChat) unlistenChat();
      if (unlistenGate) unlistenGate();
      if (unlistenPrefill) unlistenPrefill();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;

      if (cmd && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
        return;
      }

      // Inari Live V1 — Ctrl/Cmd+P jumps straight to Settings → Projects
      // from anywhere in the app. preventDefault blocks the browser
      // Print dialog (irrelevant in a chat surface). When Settings is
      // already open, this just switches the active tab.
      if (cmd && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setSettingsSection("projects");
        setSettingsOpen(true);
        return;
      }

      // Audit log overlay. Multiple matchers because the ISO Spanish
      // layout types `/` as Shift+7 and the browser sometimes returns
      // `e.key === "7"` while ctrl is held (no shift→char fold-in).
      // We accept the US Slash key, the Shift+/ "?" variant, the
      // physical `Slash` code, the ISO Spanish Shift+7, AND a
      // layout-independent Ctrl+Shift+A for keyboards where neither
      // works.
      const isAuditCombo =
        cmd && (
          e.key === "/" ||
          e.key === "?" ||
          e.code === "Slash" ||
          (e.shiftKey && e.code === "Digit7") ||
          (e.shiftKey && e.key.toLowerCase() === "a")
        );
      if (isAuditCombo) {
        e.preventDefault();
        setAuditOpen((v) => !v);
        return;
      }

      // Recordings overlay — Ctrl+Shift+R (matches the design comp's
      // "cmd+shift+R" intent on macOS via meta or ctrl).
      if (cmd && e.shiftKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        setRecordingsOpen((v) => !v);
        return;
      }

      // Find sources (inari-search) — Ctrl+Shift+F. Opens the
      // SearchPanel as a modal with a placeholder error so Jesus can
      // review the design without firing a real tool call. The agent
      // will surface this surface inline once `search.error_context`
      // is wired into the chat tool pipeline.
      if (cmd && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }

      // Inari Live V1 — Session 5: Cmd+B toggles the conversation
      // inbox overlay. Mnemonic: "B for inbox" (Linear's convention).
      if (cmd && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setInboxOpen((v) => !v);
        return;
      }

      // Incident Player — Ctrl+Shift+I. Full-screen overlay showing the
      // 20 most recent alerts; clicking one expands the PlayerCard inline.
      if (cmd && e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setPlayerOpen((v) => !v);
        return;
      }

      // ESC closes whatever overlay is on top.
      if (e.key === "Escape") {
        if (playerOpen) {
          setPlayerOpen(false);
          return;
        }
        if (activeConversationId) {
          setActiveConversationId(null);
          return;
        }
        if (inboxOpen) {
          setInboxOpen(false);
          return;
        }
        if (searchOpen) {
          setSearchOpen(false);
          return;
        }
        if (recordingsOpen) {
          setRecordingsOpen(false);
          return;
        }
        if (auditOpen) {
          setAuditOpen(false);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [auditOpen, recordingsOpen, searchOpen, inboxOpen, playerOpen, activeConversationId, setSettingsSection]);

  return (
    <div
      data-testid="main-window"
      data-mode={mode}
      className="h-full w-full flex flex-col"
      style={{ background: "var(--bg)" }}
    >
      <header
        data-tauri-drag-region
        className="flex items-center justify-between px-4 select-none"
        style={{
          height: 40,
          borderBottom: "1px solid var(--border)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.025), rgba(255,255,255,0) 70%)",
          cursor: "grab",
        }}
      >
        <div data-tauri-drag-region className="flex items-center gap-2">
          <InariMark size={14} />
          <span
            data-tauri-drag-region
            className="text-[12.5px] tracking-[-0.005em]"
            style={{ color: "var(--text-muted)" }}
          >
            Inari Live
          </span>
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="transition-colors"
          aria-label="Settings"
          data-testid="header-settings-button"
          style={{ color: "var(--text-subtle)" }}
        >
          <SettingsIcon size={16} strokeWidth={1.6} />
        </button>
      </header>

      <main className="flex-1 min-h-0 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {renderModePanel(mode, reduce)}
        </AnimatePresence>
      </main>

      <Dialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        className="w-[min(92vw,960px)] h-[min(85vh,620px)] !p-0 overflow-hidden border border-[var(--border-strong)]"
      >
        <Settings onClose={() => setSettingsOpen(false)} />
      </Dialog>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        intent={paletteIntent}
      />

      {auditOpen ? (
        <div
          className="fixed inset-0 z-50"
          data-testid="audit-overlay"
          style={{ background: "var(--bg)" }}
        >
          <MainAudit onClose={() => setAuditOpen(false)} />
        </div>
      ) : null}

      {playerOpen ? (
        <PlayerPanel onClose={() => setPlayerOpen(false)} />
      ) : null}

      {/* Inari Live V1 — Session 5 conversation overlays. Inbox first
       *  (z-50), conversation viewer second (z-60) so opening a row
       *  from the inbox layers the viewer on top without unmounting
       *  the inbox underneath.
       */}
      {inboxOpen ? (
        <div
          className="fixed inset-0 z-50"
          data-testid="inbox-overlay"
          style={{ background: "var(--bg)" }}
        >
          <MainInbox
            onClose={() => setInboxOpen(false)}
            onSelect={(id) => setActiveConversationId(id)}
          />
        </div>
      ) : null}

      {activeConversationId ? (
        <div
          className="fixed inset-0 z-[60]"
          data-testid="conversation-overlay"
          style={{ background: "var(--bg)" }}
        >
          <MainConversation
            conversationId={activeConversationId}
            onClose={() => setActiveConversationId(null)}
          />
        </div>
      ) : null}

      <RecordingsOverlay
        open={recordingsOpen}
        onClose={() => setRecordingsOpen(false)}
      />

      <Dialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        className="!w-[min(92vw,720px)] !max-h-[min(90vh,620px)] !p-0 overflow-hidden flex flex-col"
      >
        <SearchPanel
          errorText="TypeError: Cannot read properties of undefined (reading 'sub')"
          onClose={() => setSearchOpen(false)}
        />
      </Dialog>
    </div>
  );
}

function renderModePanel(mode: ChatMode, reduce: boolean | null): ReactNode {
  const initial = reduce ? { opacity: 0 } : { opacity: 0, y: 4 };
  const animate = reduce ? { opacity: 1 } : { opacity: 1, y: 0 };
  const exit = reduce ? { opacity: 0 } : { opacity: 0, y: -4 };
  const transition = reduce ? { duration: 0 } : { duration: 0.18, ease: "easeOut" };

  let content: ReactNode = null;
  if (mode === "idle") content = <DockIdle />;
  else if (mode === "conversation") content = <DockConversation />;
  else if (mode === "alert") content = <DockAlert />;
  else if (mode === "diff") content = <DockDiff />;
  else if (mode === "gates") content = <GateRunning />;

  return (
    <motion.div
      key={mode}
      className="h-full"
      initial={initial}
      animate={animate}
      exit={exit}
      transition={transition}
    >
      {content}
    </motion.div>
  );
}

/**
 * The Inari mark — the brand glyph. A burnt-orange fox (Inari = the
 * Japanese fox kami) lifted from the desktop icon; rendered as an
 * `<img>` so the same asset that ships in the OS taskbar shows up in
 * the titlebar, assistant header, and welcome state.
 *
 * Reads cleanly at 10 px → 64 px; the source PNG is 512×512 so even
 * the 64 px welcome render stays sharp on retina.
 */
export function InariMark({ size = 14 }: { size?: number }) {
  return (
    <img
      src="/inari-fox.png"
      alt=""
      aria-hidden
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        display: "block",
        userSelect: "none",
        // crisp scaling — keep the original pixel grid when downscaled
        // for the 10/14/22 px callsites.
        imageRendering: "auto",
      }}
      draggable={false}
    />
  );
}
