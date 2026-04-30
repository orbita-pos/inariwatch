/**
 * App-wide UI state (theme, active repo, focused window). NOT a cache for
 * server data — that flows from `lib/ipc.ts` via Tauri events.
 */

import { create } from "zustand";

import { applyTheme, detectSystemTheme, type ResolvedTheme, type ThemeMode } from "@/lib/theme";

interface AppState {
  themeMode: ThemeMode;
  systemTheme: ResolvedTheme;
  activeRepoId: string | null;
  setThemeMode: (mode: ThemeMode) => void;
  setSystemTheme: (theme: ResolvedTheme) => void;
  setActiveRepo: (id: string | null) => void;
}

const initialSystem: ResolvedTheme =
  typeof window === "undefined" ? "light" : detectSystemTheme();

export const useAppState = create<AppState>((set) => ({
  themeMode: "auto",
  systemTheme: initialSystem,
  activeRepoId: null,
  setThemeMode: (mode) => {
    set({ themeMode: mode });
    // Side-effect: keep DOM attributes in sync. Components don't need to read
    // the resolved theme to style — the CSS does it via attribute selectors.
    if (typeof document !== "undefined") {
      const sys = detectSystemTheme();
      applyTheme(mode, sys);
    }
  },
  setSystemTheme: (theme) => set({ systemTheme: theme }),
  setActiveRepo: (id) => set({ activeRepoId: id }),
}));
