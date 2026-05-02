import { create } from "zustand";

import type { CommandPaletteIntent } from "@/components/CommandPalette";

/**
 * Global command palette controller. The palette itself is mounted
 * exactly once inside MainWindow; sidebar buttons (search 🔍, compose ✏️)
 * and any future affordance call `open(intent)` to surface it.
 *
 * Cmd/Ctrl+K still works inside the palette's own keyboard handler
 * for "default" intent — this store only controls the explicit
 * surface points.
 */
interface CommandPaletteStore {
  open: boolean;
  intent: CommandPaletteIntent;
  setOpen: (next: boolean) => void;
  openWithIntent: (intent: CommandPaletteIntent) => void;
}

export const useCommandPalette = create<CommandPaletteStore>((set) => ({
  open: false,
  intent: "default",
  setOpen: (next) => set({ open: next }),
  openWithIntent: (intent) => set({ open: true, intent }),
}));
