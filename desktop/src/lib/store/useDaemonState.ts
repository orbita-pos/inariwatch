/**
 * Mirrors the latest `daemon:status_changed` payload into a Zustand store
 * so any component can read uptime / repo-count / sensor-count without
 * subscribing directly to Tauri events.
 *
 * The daemon → frontend bridge lives in `lib/ipc.ts`. This store is just a
 * cache; we attach the listener once at app boot from each window entry
 * (dock.tsx, main.tsx) via `bindDaemonStatus()`. Calling `bindDaemonStatus`
 * twice is idempotent — the second call no-ops and re-uses the existing
 * subscription.
 */

import { create } from "zustand";

import { onDaemonStatusChanged, type DaemonStatusDto } from "@/lib/ipc";

interface DaemonStateStore {
  status: DaemonStatusDto | null;
  bound: boolean;
  setStatus: (status: DaemonStatusDto) => void;
  setBound: (bound: boolean) => void;
}

export const useDaemonState = create<DaemonStateStore>((set) => ({
  status: null,
  bound: false,
  setStatus: (status) => set({ status }),
  setBound: (bound) => set({ bound }),
}));

let unlisten: (() => void) | null = null;

/** Subscribe once to `daemon:status_changed`; returns the unbind fn. */
export async function bindDaemonStatus(): Promise<() => void> {
  if (useDaemonState.getState().bound) {
    return () => {
      if (unlisten) unlisten();
      unlisten = null;
      useDaemonState.getState().setBound(false);
    };
  }
  useDaemonState.getState().setBound(true);
  unlisten = await onDaemonStatusChanged((s) =>
    useDaemonState.getState().setStatus(s),
  );
  return () => {
    if (unlisten) unlisten();
    unlisten = null;
    useDaemonState.getState().setBound(false);
  };
}
