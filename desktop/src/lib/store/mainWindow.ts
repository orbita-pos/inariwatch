/**
 * Main window route state. Sesión 17 ships an in-memory router rather
 * than pulling React Router DOM (deemed overkill for 5 tabs — see
 * DECISIONS 2026-05-01 "Zustand-routed main window").
 */

import { create } from "zustand";

export type MainRoute =
  | "inbox"
  | "activity"
  | "audit"
  | "memory"
  | "patterns"
  | "settings";

interface MainWindowStore {
  route: MainRoute;
  setRoute: (route: MainRoute) => void;
}

export const useMainWindow = create<MainWindowStore>((set) => ({
  route: "inbox",
  setRoute: (route) => set({ route }),
}));

export function __resetMainWindowForTests(): void {
  useMainWindow.setState({ route: "inbox" });
}
