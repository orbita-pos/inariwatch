/**
 * Zustand store + keyboard hook for the AlertDetailPanel toggle.
 *
 * Open/close state persists to localStorage so the panel remembers
 * the user's preference across app launches. The keyboard shortcut
 * is `Cmd+\` on macOS / `Ctrl+\` everywhere else. We DON'T capture
 * `Cmd+Shift+\` or other modifier combos — let those flow to the
 * OS / app.
 *
 * Usage at the layout level:
 *
 *   const { isOpen, toggle, close, anchorAlertId } = useAlertDetailPanel()
 *   useAlertDetailPanelKeyboard()   // installs the global hotkey
 *
 *   return (
 *     <>
 *       <ChatSurface />
 *       {isOpen && (
 *         <AlertDetailPanel alertId={anchorAlertId} onClose={close} />
 *       )}
 *     </>
 *   )
 *
 * The store also exposes `setAnchor(alertId)` so the chat surface can
 * tell the panel which alert to show when the user switches
 * conversations (S5 conversations are anchored to alerts).
 */

import { useEffect } from "react"
import { create } from "zustand"

const STORAGE_KEY = "inari.alert-detail-panel.isOpen"

function loadInitialOpen(): boolean {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return false
  try {
    return localStorage.getItem(STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

function persistOpen(open: boolean): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, open ? "1" : "0")
  } catch {
    // Storage unavailable — fail silent. Preference is non-critical.
  }
}

interface AlertDetailPanelStore {
  /** Whether the panel is open. Persisted to localStorage. */
  isOpen: boolean
  /** Alert anchored to the currently-active conversation. Null = no anchor. */
  anchorAlertId: string | null

  open(): void
  close(): void
  toggle(): void
  /** Update the alert the panel is showing. Called by the chat surface
   *  whenever the active conversation changes. */
  setAnchor(alertId: string | null): void
}

export const useAlertDetailPanel = create<AlertDetailPanelStore>((set, get) => ({
  isOpen: loadInitialOpen(),
  anchorAlertId: null,

  open: () => {
    if (get().isOpen) return
    set({ isOpen: true })
    persistOpen(true)
  },
  close: () => {
    if (!get().isOpen) return
    set({ isOpen: false })
    persistOpen(false)
  },
  toggle: () => {
    const next = !get().isOpen
    set({ isOpen: next })
    persistOpen(next)
  },
  setAnchor: (alertId) => {
    if (get().anchorAlertId === alertId) return
    set({ anchorAlertId: alertId })
  },
}))

/**
 * Mount-time hook that installs the global `Cmd+\` / `Ctrl+\` toggle
 * and `Esc` close. Call once at the top of the layout — installing
 * multiple times is harmless (the listener dedupes) but wasteful.
 *
 * Bypasses the keyboard handler when the active element is an
 * `<input>` / `<textarea>` / contenteditable — the user is typing
 * and we don't want to steal their `\` key. The `Cmd+\` combo isn't
 * something a normal text input would care about, but defense in
 * depth.
 */
export function useAlertDetailPanelKeyboard(): void {
  const toggle = useAlertDetailPanel((s) => s.toggle)
  const close = useAlertDetailPanel((s) => s.close)
  const isOpen = useAlertDetailPanel((s) => s.isOpen)

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Cmd+\ on macOS, Ctrl+\ elsewhere. Backslash key codes vary by
      // layout — match on key first, then code as fallback.
      const isBackslash = e.key === "\\" || e.code === "Backslash"
      const isToggleCombo = isBackslash && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
      if (isToggleCombo) {
        e.preventDefault()
        toggle()
        return
      }
      // Esc closes when open. Skip when focus is in a contenteditable
      // / input so the user's normal escape-to-clear in inputs still
      // works. We only handle Esc when the panel is open AND the
      // user isn't typing.
      if (e.key === "Escape" && isOpen) {
        const target = e.target as HTMLElement | null
        const tag = target?.tagName?.toLowerCase()
        const isInput = tag === "input" || tag === "textarea" || (target?.isContentEditable ?? false)
        if (!isInput) {
          e.preventDefault()
          close()
        }
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [toggle, close, isOpen])
}
