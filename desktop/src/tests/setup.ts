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
 * jsdom doesn't implement `ResizeObserver`. cmdk subscribes one to
 * size its result list on first mount, so omitting the stub blows up
 * any test that renders the CommandPalette tree.
 */
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // @ts-expect-error — assigning a minimal shim to a DOM global.
  globalThis.ResizeObserver = ResizeObserverStub;
}

/**
 * jsdom's Element doesn't implement `scrollIntoView`. cmdk calls it
 * on every selection change — leaving it undefined turns those into
 * `TypeError: i.scrollIntoView is not a function`.
 */
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoViewStub() {};
}

/**
 * Tauri commands aren't available in jsdom. The dock and main shells
 * lazy-bind to `daemon:status_changed` only when they explicitly call
 * `bindDaemonStatus()`, which the tests don't trigger — so no global
 * stub is needed for the Session 14 surface. Future tests that need
 * `invoke()` can stub via `vi.mock("@tauri-apps/api/core")`.
 */
