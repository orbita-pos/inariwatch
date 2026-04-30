import "@testing-library/jest-dom/vitest";

/**
 * jsdom doesn't ship `matchMedia`. The theme system + reduced-motion
 * detection both query it on first render, so each test gets a stub
 * unless it overrides via `window.matchMedia = vi.fn(...)`.
 */
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

/**
 * Tauri commands aren't available in jsdom. The dock and main shells
 * lazy-bind to `daemon:status_changed` only when they explicitly call
 * `bindDaemonStatus()`, which the tests don't trigger — so no global
 * stub is needed for the Session 14 surface. Future tests that need
 * `invoke()` can stub via `vi.mock("@tauri-apps/api/core")`.
 */
