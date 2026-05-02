import * as RadixDialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import {
  FileSearch,
  MessageSquare,
  Search,
  Settings as SettingsIcon,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import {
  hideDock,
  listRecentAlerts,
  openMainWindow,
  searchCodebase,
  type RecentAlert,
  type SearchHit,
} from "@/lib/dock-ipc";
import { useChat } from "@/lib/store/chat";

/**
 * The palette has three "intents" that bias which group is visible
 * first. `default` shows the four root commands. `search` jumps
 * straight to the search-results view. `fix` shows the recent-alerts
 * picker. Sesión 16/19 expand the search-results UX into a full Mode 3.
 */
export type CommandPaletteIntent = "default" | "search" | "fix";

interface CommandPaletteProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Bias which group renders first when the palette opens. */
  intent?: CommandPaletteIntent;
}

interface RootCommand {
  id: "chat" | "search" | "fix" | "settings";
  label: string;
  hint: string;
  icon: LucideIcon;
}

const ROOT_COMMANDS: RootCommand[] = [
  {
    id: "chat",
    label: "Chat with Inari",
    hint: "Ask anything about this repo",
    icon: MessageSquare,
  },
  {
    id: "search",
    label: "Search code",
    hint: "Semantic search across the indexed repo",
    icon: FileSearch,
  },
  {
    id: "fix",
    label: "Fix latest error",
    hint: "Run a remediation pass on the last alert",
    icon: Wrench,
  },
  {
    id: "settings",
    label: "Open Settings",
    hint: "Theme, sensors, AI, account",
    icon: SettingsIcon,
  },
];

type View = "root" | "search" | "fix";

/**
 * Command palette wired to the four root actions. ⌘/Ctrl+K toggles
 * open. ESC closes. Once a root command is picked, the palette
 * either:
 *   - chat → transition the dock into Mode 2 + close.
 *   - search → switch to the in-palette search-results view.
 *   - fix → list recent alerts; selecting one will (Sesión 16) open
 *     Mode 3 (alert triage). Sesión 15 closes the palette + logs
 *     the chosen alert id for the future Mode 3 wiring.
 *   - settings → call `open_main_window("settings")` + close.
 */
export function CommandPalette({
  open: controlledOpen,
  onOpenChange,
  intent = "default",
}: CommandPaletteProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    if (controlledOpen === undefined) setInternalOpen(next);
  };

  const startConversation = useChat((s) => s.startConversation);
  const setInputValue = useChat((s) => s.setInputValue);

  // Initial view follows `intent` whenever the palette opens.
  const [view, setView] = useState<View>(intent === "default" ? "root" : intent);
  useEffect(() => {
    if (open) {
      setView(intent === "default" ? "root" : intent);
    }
  }, [open, intent]);

  // Search & fix sub-views maintain their own local state. We do NOT
  // persist them in Zustand — the palette is ephemeral and resetting
  // on every open feels right.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [recentAlerts, setRecentAlerts] = useState<RecentAlert[]>([]);
  const [loadingAlerts, setLoadingAlerts] = useState(false);

  // Reload recent alerts each time we enter the fix view.
  useEffect(() => {
    if (view !== "fix" || !open) return;
    let cancelled = false;
    setLoadingAlerts(true);
    listRecentAlerts()
      .then((alerts) => {
        if (!cancelled) setRecentAlerts(alerts);
      })
      .finally(() => {
        if (!cancelled) setLoadingAlerts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, open]);

  // Debounced search. The trailing-edge timer fires once typing
  // pauses; canceling on every keystroke avoids running the IPC for
  // every character the user types.
  useEffect(() => {
    if (view !== "search") return;
    if (!searchQuery.trim()) {
      setSearchHits([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const id = setTimeout(() => {
      searchCodebase(searchQuery)
        .then((hits) => {
          if (!cancelled) setSearchHits(hits);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [searchQuery, view]);

  // ⌘/Ctrl+K toggle + ESC close. The Tauri global shortcut also opens
  // the palette by setting `open` from the parent — both paths land here.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const trigger = e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey);
      if (trigger) {
        e.preventDefault();
        setOpen(!open);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRootSelect = (id: RootCommand["id"]) => {
    if (id === "chat") {
      startConversation();
      setOpen(false);
      return;
    }
    if (id === "settings") {
      openMainWindow("settings");
      setOpen(false);
      return;
    }
    setView(id === "search" ? "search" : "fix");
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Inari command palette"
      // Backdrop overlay (Radix sibling element) gets backdrop-blur + dark
      // tint so the palette reads as floating ABOVE the page, not blending
      // into it. The dialog itself uses --card-elevated (one tier above
      // --card / --surface) + a visible border + real drop shadow.
      overlayClassName="fixed inset-0 z-[150] bg-black/70 backdrop-blur-md"
      className={cn(
        "fixed left-1/2 top-[18%] -translate-x-1/2 w-[min(92vw,560px)]",
        "rounded-[var(--radius-lg)] border border-[var(--border-strong)]",
        "bg-[var(--card-elevated)] overflow-hidden",
        "shadow-2xl shadow-black/60",
        "z-[200]",
      )}
    >
      {/*
        Radix DialogContent requires a DialogTitle in the tree for screen
        readers. We render one visually-hidden so the AT announcement is
        meaningful ("Command palette") without leaking into the visible
        UI. Closes the Sesión 14 a11y warning.
      */}
      <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
      <RadixDialog.Description className="sr-only">
        Quick actions for chatting, searching code, fixing alerts, and
        opening settings.
      </RadixDialog.Description>

      {view === "search" ? (
        <SearchView
          query={searchQuery}
          onQueryChange={setSearchQuery}
          hits={searchHits}
          searching={searching}
          onBack={() => setView("root")}
          onPick={(hit) => {
            // Drop the hit path into the dock input as a starter prompt
            // — the user can refine before sending. Sesión 16 ships
            // Mode 3 with a richer search-result preview.
            setInputValue(`Show me ${hit.path}`);
            setOpen(false);
          }}
        />
      ) : view === "fix" ? (
        <FixView
          alerts={recentAlerts}
          loading={loadingAlerts}
          onBack={() => setView("root")}
          onPick={(alert) => {
            console.info(
              `[palette] fix picked alert ${alert.id} — Mode 3 wiring lands in Sesión 16`,
            );
            // Mode 3 doesn't exist yet — for now, drop a starter prompt
            // and close so the user has SOMETHING to click. The dock
            // alert surface will replace this in Sesión 16.
            setInputValue(`Help me fix: ${alert.title}`);
            hideDock();
            setOpen(false);
          }}
        />
      ) : (
        <RootView onSelect={onRootSelect} />
      )}
    </Command.Dialog>
  );
}

interface RootViewProps {
  onSelect: (id: RootCommand["id"]) => void;
}

function RootView({ onSelect }: RootViewProps) {
  return (
    <>
      <PaletteInputBar placeholder="Ask Inari, search, or run a command…" />
      <Command.List className="max-h-[320px] overflow-auto p-2">
        <Command.Empty className="text-sm text-[var(--muted)] p-3">
          No matches.
        </Command.Empty>
        <Command.Group heading="Quick actions">
          {ROOT_COMMANDS.map((c) => {
            const Icon = c.icon;
            return (
              <Command.Item
                key={c.id}
                value={`${c.label} ${c.hint}`}
                onSelect={() => onSelect(c.id)}
                data-testid={`palette-command-${c.id}`}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-[var(--radius-sm)]",
                  "cursor-pointer select-none text-sm text-[var(--text)]",
                  "data-[selected=true]:bg-white/[0.06] data-[selected=true]:text-[var(--text)]",
                )}
              >
                <Icon className="h-4 w-4 text-[var(--muted)]" aria-hidden />
                <span className="flex-1">{c.label}</span>
                <span className="text-xs text-[var(--muted)]">{c.hint}</span>
              </Command.Item>
            );
          })}
        </Command.Group>
      </Command.List>
    </>
  );
}

interface SearchViewProps {
  query: string;
  onQueryChange: (q: string) => void;
  hits: SearchHit[];
  searching: boolean;
  onBack: () => void;
  onPick: (hit: SearchHit) => void;
}

function SearchView({
  query,
  onQueryChange,
  hits,
  searching,
  onBack,
  onPick,
}: SearchViewProps) {
  return (
    <>
      <PaletteInputBar
        placeholder="Search code by symbol, file, or fragment…"
        autoFocusValue={query}
        onValueChange={onQueryChange}
        onEscape={onBack}
      />
      <Command.List className="max-h-[320px] overflow-auto p-2">
        <Command.Empty className="text-sm text-[var(--muted)] p-3">
          {searching
            ? "Searching…"
            : query
              ? "No matches in this repo."
              : "Start typing to search."}
        </Command.Empty>
        {hits.length > 0 ? (
          <Command.Group heading="Code results">
            {hits.map((hit) => (
              <Command.Item
                key={hit.id}
                value={`${hit.path} ${hit.preview}`}
                onSelect={() => onPick(hit)}
                className={cn(
                  "flex flex-col gap-0.5 px-3 py-2 rounded-[var(--radius-sm)]",
                  "cursor-pointer select-none text-sm text-[var(--text)]",
                  "data-[selected=true]:bg-white/[0.06] data-[selected=true]:text-[var(--text)]",
                )}
              >
                <span className="font-[var(--font-mono)] text-xs">
                  {hit.path}
                </span>
                <span className="text-xs text-[var(--muted)] truncate">
                  {hit.preview}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
      </Command.List>
    </>
  );
}

interface FixViewProps {
  alerts: RecentAlert[];
  loading: boolean;
  onBack: () => void;
  onPick: (alert: RecentAlert) => void;
}

function FixView({ alerts, loading, onBack, onPick }: FixViewProps) {
  return (
    <>
      <PaletteInputBar
        placeholder="Pick an alert to fix…"
        onEscape={onBack}
      />
      <Command.List className="max-h-[320px] overflow-auto p-2">
        <Command.Empty className="text-sm text-[var(--muted)] p-3">
          {loading
            ? "Loading recent alerts…"
            : "No alerts in the last 24h. Inari is keeping an eye out."}
        </Command.Empty>
        {alerts.length > 0 ? (
          <Command.Group heading="Recent alerts">
            {alerts.map((alert) => (
              <Command.Item
                key={alert.id}
                value={`${alert.title} ${alert.source}`}
                onSelect={() => onPick(alert)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-[var(--radius-sm)]",
                  "cursor-pointer select-none text-sm text-[var(--text)]",
                  "data-[selected=true]:bg-white/[0.06] data-[selected=true]:text-[var(--text)]",
                )}
              >
                <span className="flex-1 truncate">{alert.title}</span>
                <span className="text-xs text-[var(--muted)]">{alert.source}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
      </Command.List>
    </>
  );
}

interface PaletteInputBarProps {
  placeholder: string;
  autoFocusValue?: string;
  onValueChange?: (v: string) => void;
  onEscape?: () => void;
}

function PaletteInputBar({
  placeholder,
  autoFocusValue,
  onValueChange,
  onEscape,
}: PaletteInputBarProps) {
  return (
    <div className="flex items-center gap-2 px-3 border-b border-[var(--border)]">
      <Search className="h-4 w-4 text-[var(--muted)]" aria-hidden />
      <Command.Input
        placeholder={placeholder}
        value={autoFocusValue}
        onValueChange={onValueChange}
        onKeyDown={(e) => {
          if (e.key === "Escape" && onEscape) {
            e.preventDefault();
            onEscape();
          }
        }}
        // Suppress the global :focus-visible orange outline from globals.css
        // — it's load-bearing for buttons/links a11y but reads as a thick
        // accent box around a text field inside an already-focused dialog.
        // The dialog itself + the cursor are sufficient focus indicators.
        className={cn(
          "flex-1 h-11 bg-transparent text-sm text-[var(--text)]",
          "placeholder:text-[var(--muted)] outline-none focus:outline-none focus-visible:outline-none",
        )}
      />
    </div>
  );
}
