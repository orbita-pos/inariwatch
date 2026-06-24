import * as RadixDialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import {
  FileText,
  KeyRound,
  MessageSquare,
  Search,
  Settings as SettingsIcon,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

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
 * first. `default` shows the root commands. `search` jumps straight
 * to the search-results view. `fix` shows the recent-alerts picker.
 */
export type CommandPaletteIntent = "default" | "search" | "fix";

interface CommandPaletteProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  intent?: CommandPaletteIntent;
}

interface RootCommand {
  id: "chat" | "search" | "fix" | "audit" | "settings";
  label: string;
  helper: string;
  icon: LucideIcon;
  kbd: string;
}

const ROOT_COMMANDS: RootCommand[] = [
  {
    id: "chat",
    label: "Ask Inari something",
    helper: "Open a fresh conversation",
    icon: MessageSquare,
    kbd: "⏎ default",
  },
  {
    id: "search",
    label: "Search the codebase",
    helper: "Semantic + fuzzy across the indexed repo",
    icon: Search,
    kbd: "⌘ K",
  },
  {
    id: "fix",
    label: "Fix the latest error",
    helper: "Run a remediation pass on the last alert",
    icon: Wrench,
    kbd: "⌘ ⇧ F",
  },
  {
    id: "audit",
    label: "Open audit log",
    helper: "Inspect the chain of signed receipts",
    icon: FileText,
    kbd: "⌘ /",
  },
  {
    id: "settings",
    label: "Open settings",
    helper: "Theme, AI key, permissions, channels",
    icon: SettingsIcon,
    kbd: "⌘ ,",
  },
];

type View = "root" | "search" | "fix";

/**
 * Command palette — 2026-05-07 design pivot.
 *
 * Same chrome on all 3 views (input bar + ⌘K hint + footer hints);
 * only the body content swaps. Selected row gets cream stripe on the
 * left + cream-tinted wash. Mono file paths in search; severity dots
 * in fix.
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

  const [view, setView] = useState<View>(intent === "default" ? "root" : intent);
  useEffect(() => {
    if (open) {
      setView(intent === "default" ? "root" : intent);
    }
  }, [open, intent]);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [recentAlerts, setRecentAlerts] = useState<RecentAlert[]>([]);
  const [loadingAlerts, setLoadingAlerts] = useState(false);

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
    if (id === "audit") {
      // Triggers the cmd+/ overlay path in MainWindow.
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "/",
          ctrlKey: true,
          metaKey: false,
        }),
      );
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
      overlayClassName="fixed inset-0 z-[150] bg-black/40 backdrop-blur-md"
      className={cn(
        "fixed left-1/2 top-[18%] -translate-x-1/2 w-[min(92vw,640px)]",
        "rounded-[var(--radius-xl)] overflow-hidden",
        "z-[200]",
      )}
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border-strong)",
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.05) inset, 0 40px 100px -28px rgba(0,0,0,0.85), 0 12px 30px -10px rgba(0,0,0,0.6)",
      }}
    >
      <RadixDialog.Title className="sr-only">Inari command palette</RadixDialog.Title>
      <RadixDialog.Description className="sr-only">
        Quick actions for chatting, searching code, fixing alerts, opening the
        audit log, and opening settings.
      </RadixDialog.Description>

      {view === "search" ? (
        <SearchView
          query={searchQuery}
          onQueryChange={setSearchQuery}
          hits={searchHits}
          searching={searching}
          onBack={() => setView("root")}
          onPick={(hit) => {
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
            setInputValue(`Help me fix: ${alert.title}`);
            hideDock();
            setOpen(false);
          }}
        />
      ) : (
        <RootView onSelect={onRootSelect} />
      )}

      <PaletteFooter view={view} />
    </Command.Dialog>
  );
}

// ── Views ───────────────────────────────────────────────────────────────────

interface RootViewProps {
  onSelect: (id: RootCommand["id"]) => void;
}

function RootView({ onSelect }: RootViewProps) {
  return (
    <>
      <PaletteInputBar
        placeholder="Search invocations · run a command · ask Inari…"
        showKbdHint
      />
      <Command.List
        className="max-h-[360px] overflow-auto px-2 py-2"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <Command.Empty
          className="text-[12.5px] px-3 py-3"
          style={{ color: "var(--text-subtle)" }}
        >
          No matches.
        </Command.Empty>
        <SectionHeading>Commands</SectionHeading>
        {ROOT_COMMANDS.map((c) => {
          const Icon = c.icon;
          return (
            <Command.Item
              key={c.id}
              value={`${c.label} ${c.helper}`}
              onSelect={() => onSelect(c.id)}
              data-testid={`palette-command-${c.id}`}
              className="palette-row"
            >
              <Icon size={13} strokeWidth={1.7} className="palette-row__icon" aria-hidden />
              <span className="palette-row__label">{c.label}</span>
              <span className="palette-row__helper">{c.helper}</span>
              <Kbd>{c.kbd}</Kbd>
            </Command.Item>
          );
        })}

        <div className="mt-2">
          <SectionHeading>
            Recent
            <span style={{ color: "var(--text-faint)", marginLeft: 8, fontWeight: 400 }}>
              tool invocations
            </span>
          </SectionHeading>
          <RecentRow
            time="02:18"
            tool="comm.send_telegram"
            witness="w_3a1c8e9"
          />
          <RecentRow
            time="02:14"
            tool="search.error_context"
            witness="w_5e8b2f1"
          />
        </div>
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
        showKbdHint
      />
      <Command.List
        className="max-h-[360px] overflow-auto px-2 py-2"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <Command.Empty
          className="text-[12.5px] px-3 py-3"
          style={{ color: "var(--text-subtle)" }}
        >
          {searching
            ? "Searching…"
            : query
              ? "No matches in this repo."
              : "Start typing to search."}
        </Command.Empty>
        {hits.length > 0 ? (
          <>
            <SectionHeading>
              Search results
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-faint)",
                }}
              >
                {hits.length} results
              </span>
            </SectionHeading>
            {hits.map((hit) => (
              <Command.Item
                key={hit.id}
                value={`${hit.path} ${hit.preview}`}
                onSelect={() => onPick(hit)}
                className="palette-row palette-row--search"
              >
                <span
                  className="palette-row__path"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {hit.path}
                </span>
                <span className="palette-row__preview">{hit.preview}</span>
              </Command.Item>
            ))}
          </>
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
        showKbdHint
      />
      <Command.List
        className="max-h-[360px] overflow-auto px-2 py-2"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <Command.Empty
          className="text-[12.5px] px-3 py-3"
          style={{ color: "var(--text-subtle)" }}
        >
          {loading
            ? "Loading recent alerts…"
            : "No alerts in the last 24h. Inari is keeping an eye out."}
        </Command.Empty>
        {alerts.length > 0 ? (
          <>
            <SectionHeading>Recent alerts</SectionHeading>
            {alerts.map((alert) => (
              <Command.Item
                key={alert.id}
                value={`${alert.title} ${alert.source}`}
                onSelect={() => onPick(alert)}
                className="palette-row palette-row--alert"
              >
                <SeverityDot source={alert.source} />
                <span className="palette-row__alert-title">{alert.title}</span>
                <span
                  className="palette-row__helper"
                  style={{ marginLeft: "auto" }}
                >
                  {alert.source}
                </span>
              </Command.Item>
            ))}
          </>
        ) : null}
      </Command.List>
    </>
  );
}

// ── Bits ───────────────────────────────────────────────────────────────────

interface PaletteInputBarProps {
  placeholder: string;
  autoFocusValue?: string;
  onValueChange?: (v: string) => void;
  onEscape?: () => void;
  showKbdHint?: boolean;
}

function PaletteInputBar({
  placeholder,
  autoFocusValue,
  onValueChange,
  onEscape,
  showKbdHint = false,
}: PaletteInputBarProps) {
  return (
    <div
      className="flex items-center gap-2 px-3.5"
      style={{ height: 48 }}
    >
      <Search size={13} strokeWidth={1.7} style={{ color: "var(--text-subtle)" }} aria-hidden />
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
        className={cn(
          "flex-1 h-11 bg-transparent outline-none focus:outline-none focus-visible:outline-none",
        )}
        style={{
          fontSize: 13.5,
          color: "var(--text)",
          letterSpacing: "-0.005em",
        }}
      />
      {showKbdHint ? (
        <Kbd subtle>⌘ K</Kbd>
      ) : null}
    </div>
  );
}

interface PaletteFooterProps {
  view: View;
}

function PaletteFooter({ view }: PaletteFooterProps) {
  void view;
  return (
    <div
      className="flex items-center gap-3 px-3.5 text-[10.5px]"
      style={{
        height: 32,
        borderTop: "1px solid var(--border)",
        background: "rgba(255,255,255,0.012)",
        color: "var(--text-faint)",
        fontFamily: "var(--font-mono)",
      }}
    >
      <FooterHint kbd="↑↓" label="navigate" />
      <Sep />
      <FooterHint kbd="⏎" label="run" />
      <Sep />
      <FooterHint kbd="esc" label="close" />
    </div>
  );
}

function FooterHint({ kbd, label }: { kbd: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span style={{ color: "var(--text-subtle)" }}>{kbd}</span>
      <span>{label}</span>
    </span>
  );
}

function Sep() {
  return <span style={{ color: "var(--text-faint)" }}>·</span>;
}

function Kbd({ children, subtle = false }: { children: ReactNode; subtle?: boolean }) {
  return (
    <span
      className="inline-flex items-center justify-center px-1.5"
      style={{
        height: 18,
        borderRadius: 4,
        background: "rgba(255,255,255,0.04)",
        border: "1px solid var(--border-strong)",
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        color: subtle ? "var(--text-faint)" : "var(--text-subtle)",
      }}
    >
      {children}
    </span>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-center px-3 pb-1.5 pt-2"
      style={{
        color: "var(--text-faint)",
        fontSize: 10.5,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        fontWeight: 500,
      }}
    >
      {children}
    </div>
  );
}

interface RecentRowProps {
  time: string;
  tool: string;
  witness: string;
}

function RecentRow({ time, tool, witness }: RecentRowProps) {
  return (
    <div className="palette-row palette-row--recent">
      <span
        className="palette-row__time"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {time}
      </span>
      <span
        className="palette-row__tool"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {tool}
      </span>
      <span
        className="ml-auto inline-flex items-center gap-1.5"
        style={{
          height: 20,
          padding: "0 7px",
          borderRadius: 999,
          background:
            "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))",
          border: "1px solid rgba(166,194,176,0.18)",
          color: "var(--verified)",
          fontSize: 10.5,
          lineHeight: 1,
        }}
      >
        <KeyRound size={10} strokeWidth={1.6} />
        <span style={{ color: "rgba(166,194,176,0.78)" }}>verified</span>
        <span style={{ color: "rgba(166,194,176,0.35)" }}>·</span>
        <span style={{ fontFamily: "var(--font-mono)", color: "#C8DDD0" }}>
          {witness}
        </span>
      </span>
    </div>
  );
}

function SeverityDot({ source }: { source: string }) {
  const lower = source.toLowerCase();
  const color = lower.includes("sentry")
    ? "var(--denied)"
    : lower.includes("vercel")
      ? "var(--pending)"
      : "var(--verified)";
  return (
    <span
      aria-hidden
      className="shrink-0"
      style={{
        width: 7,
        height: 7,
        borderRadius: 999,
        background: color,
        boxShadow: "0 0 0 2px rgba(255,255,255,0.025)",
      }}
    />
  );
}
