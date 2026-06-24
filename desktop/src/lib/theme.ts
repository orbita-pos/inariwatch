/**
 * Theme resolver.
 *
 * Three modes user-facing: `auto` (follow OS), `light`, `dark`. Persistence
 * goes through SQL settings via the `desktop_get_settings` / `desktop_save_settings`
 * IPC commands (Session 4) — `theme` is just a string key in the settings KV.
 *
 * The DOM-side flow:
 *   1. `applyTheme(mode, system)` writes `data-theme` + `data-system-theme`
 *      attributes on `<html>`. The CSS in `globals.css` reads them and swaps
 *      the OKLCH palette tokens.
 *   2. `subscribeSystemTheme(cb)` listens to the `prefers-color-scheme`
 *      media query so `auto` keeps following OS changes after first paint.
 *
 * We intentionally do NOT call into Tauri's `theme()` getter on every render —
 * it requires an async invoke and the CSS media query gives us the same answer
 * synchronously. The Tauri getter is only useful when the user has overridden
 * the OS-level theme through Tauri's own API (rare, deferred to Session 17).
 */

export type ThemeMode = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const VALID: readonly ThemeMode[] = ["auto", "light", "dark"];

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (VALID as readonly string[]).includes(value);
}

/** Read the OS-level preference. Falls back to `light` outside the browser. */
export function detectSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Resolve a user preference + the OS preference into a concrete theme. */
export function resolveTheme(mode: ThemeMode, system: ResolvedTheme): ResolvedTheme {
  return mode === "auto" ? system : mode;
}

/**
 * Apply the theme to the document root. Idempotent — safe to call from React
 * effects on every mode change.
 */
export function applyTheme(mode: ThemeMode, system: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", mode);
  root.setAttribute("data-system-theme", system);
}

/**
 * Subscribe to OS theme changes. Returns an unsubscribe fn. No-ops outside
 * the browser. The callback fires with the new resolved theme.
 */
export function subscribeSystemTheme(cb: (theme: ResolvedTheme) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (e: MediaQueryListEvent) => cb(e.matches ? "dark" : "light");
  // Safari < 14 / older WebViews: addListener is the only path.
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }
  mql.addListener(handler);
  return () => mql.removeListener(handler);
}
