/**
 * v0.3 Phase A — collapsed-state store for the right-side cloud
 * dashboard. Persisted in localStorage so the panel state survives
 * window reloads (the user closes the window → reopens with the same
 * layout).
 *
 * Two axes:
 *   1. `panelOpen` — global toggle for the entire right rail.
 *   2. `cardCollapsed[id]` — per-card collapse so the user can fold up
 *      widgets they don't currently care about (e.g. on-call when
 *      they're alone on the project).
 *
 * Hand-rolled (≈30 LOC) instead of pulling Zustand/persist middleware:
 * the surface is read-once-on-mount + write-on-toggle, both cheap, and
 * the codebase already has lightweight stores in this same shape (see
 * `lib/store/useAppState.ts` for the pattern).
 */

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "inari-live:cloud-panel-v1";

export type CardId =
  | "status"
  | "alerts"
  | "uptime"
  | "deploys"
  | "oncall"
  | "community";

export interface CloudPanelState {
  panelOpen: boolean;
  cardCollapsed: Record<CardId, boolean>;
}

const DEFAULT_STATE: CloudPanelState = {
  panelOpen: true,
  cardCollapsed: {
    status:    false,
    alerts:    false,
    uptime:    false,
    deploys:   false,
    oncall:    true,
    community: true,
  },
};

function readStorage(): CloudPanelState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<CloudPanelState>;
    return {
      panelOpen: parsed.panelOpen ?? DEFAULT_STATE.panelOpen,
      cardCollapsed: {
        ...DEFAULT_STATE.cardCollapsed,
        ...(parsed.cardCollapsed ?? {}),
      },
    };
  } catch {
    return DEFAULT_STATE;
  }
}

let state: CloudPanelState = readStorage();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function persist() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode — ignore */
  }
}

export function getCloudPanelState(): CloudPanelState {
  return state;
}

export function setPanelOpen(open: boolean) {
  if (state.panelOpen === open) return;
  state = { ...state, panelOpen: open };
  persist();
  emit();
}

export function togglePanel() {
  setPanelOpen(!state.panelOpen);
}

export function setCardCollapsed(id: CardId, collapsed: boolean) {
  if (state.cardCollapsed[id] === collapsed) return;
  state = {
    ...state,
    cardCollapsed: { ...state.cardCollapsed, [id]: collapsed },
  };
  persist();
  emit();
}

export function toggleCard(id: CardId) {
  setCardCollapsed(id, !state.cardCollapsed[id]);
}

export function useCloudPanel(): CloudPanelState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => DEFAULT_STATE,
  );
}

/** Reset helper — used by tests so localStorage doesn't leak across runs. */
export function _resetCloudPanelStateForTests() {
  state = { ...DEFAULT_STATE, cardCollapsed: { ...DEFAULT_STATE.cardCollapsed } };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  emit();
}
