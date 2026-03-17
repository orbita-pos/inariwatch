"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Search, LayoutDashboard, Bell, BarChart3, Plug,
  Settings, FolderOpen, MessageSquare, FolderKanban, AlertCircle, X, Loader2,
} from "lucide-react";
import { searchDashboard, type SearchResult } from "./search-actions";

const NAV_SHORTCUTS = [
  { label: "Overview",     href: "/dashboard",    icon: LayoutDashboard },
  { label: "Alerts",       href: "/alerts",       icon: Bell },
  { label: "Projects",     href: "/projects",     icon: FolderOpen },
  { label: "Analytics",    href: "/analytics",    icon: BarChart3 },
  { label: "Integrations", href: "/integrations", icon: Plug },
  { label: "Ask Inari",    href: "/chat",         icon: MessageSquare },
  { label: "Settings",     href: "/settings",     icon: Settings },
];

interface SearchDialogProps {
  open:      boolean;
  onClose:   () => void;
}

export function SearchDialog({ open, onClose }: SearchDialogProps) {
  const router   = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query,   setQuery]   = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [active,  setActive]  = useState(0);
  const [pending, startTransition] = useTransition();

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    const id = setTimeout(() => {
      startTransition(async () => {
        const res = await searchDashboard(query);
        setResults(res);
        setActive(0);
      });
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  const shortcuts = query.trim().length < 2
    ? NAV_SHORTCUTS.filter((s) =>
        query.trim() === "" || s.label.toLowerCase().includes(query.toLowerCase())
      )
    : [];

  const allItems = [
    ...shortcuts.map((s) => ({ id: s.href, type: "nav" as const, title: s.label, subtitle: "Go to", href: s.href, icon: s.icon })),
    ...results,
  ];

  function navigate(href: string) {
    router.push(href);
    onClose();
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, allItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && allItems[active]) {
      navigate(allItems[active].href);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-[20%] z-50 w-full max-w-lg -translate-x-1/2 rounded-2xl border border-line bg-surface shadow-2xl shadow-black/30 dark:shadow-black/60 overflow-hidden"
          onKeyDown={handleKey}
        >
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          {/* Input */}
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            {pending
              ? <Loader2 className="h-4 w-4 shrink-0 text-zinc-500 animate-spin" />
              : <Search className="h-4 w-4 shrink-0 text-zinc-500" />
            }
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search alerts, projects, pages…"
              className="flex-1 bg-transparent text-sm text-fg-strong placeholder:text-zinc-500 outline-none"
            />
            {query && (
              <button onClick={() => setQuery("")} className="text-zinc-500 hover:text-fg-base transition-colors">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            <kbd className="hidden sm:block text-[10px] text-zinc-600 bg-surface-inner border border-line rounded px-1.5 py-0.5 font-mono">ESC</kbd>
          </div>

          {/* Results */}
          <div className="max-h-80 overflow-y-auto py-2">
            {allItems.length === 0 && query.trim().length >= 2 && !pending && (
              <p className="px-4 py-8 text-center text-sm text-zinc-500">No results for &ldquo;{query}&rdquo;</p>
            )}

            {shortcuts.length > 0 && (
              <p className="px-4 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                Navigation
              </p>
            )}

            {allItems.map((item, i) => {
              const isAlert   = item.type === "alert";
              const isProject = item.type === "project";
              const Icon = isAlert
                ? AlertCircle
                : isProject
                ? FolderKanban
                : (item as typeof shortcuts[0]).icon;

              const showResultsLabel = item.type !== "nav" && (i === 0 || allItems[i - 1].type === "nav");

              return (
                <div key={item.href + i}>
                  {showResultsLabel && (
                    <p className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                      {isAlert ? "Alerts" : "Projects"}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => navigate(item.href)}
                    onMouseEnter={() => setActive(i)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                      i === active ? "bg-surface-inner text-fg-strong" : "text-fg-base hover:bg-surface-inner"
                    }`}
                  >
                    <Icon className={`h-4 w-4 shrink-0 ${i === active ? "text-inari-accent" : "text-zinc-500"}`} />
                    <div className="min-w-0 flex-1 text-left">
                      <p className="truncate font-medium">{item.title}</p>
                    </div>
                    <span className="text-xs text-zinc-500 shrink-0">{item.subtitle}</span>
                  </button>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="border-t border-line px-4 py-2 flex items-center gap-4 text-[11px] text-zinc-500">
            <span className="flex items-center gap-1"><kbd className="font-mono">↑↓</kbd> navigate</span>
            <span className="flex items-center gap-1"><kbd className="font-mono">↵</kbd> open</span>
            <span className="flex items-center gap-1"><kbd className="font-mono">ESC</kbd> close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
