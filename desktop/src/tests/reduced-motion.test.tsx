import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DockShell } from "@/components/dock/DockShell";
import { __resetChatStoreForTests } from "@/lib/store/chat";

// Tauri event subscription is a no-op in jsdom — the chat-stream driver
// would otherwise emit a warning about the missing runtime.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

/**
 * Stub matchMedia to claim `(prefers-reduced-motion: reduce)` is true. The
 * DockShell calls `useReducedMotion()` from framer-motion which reads the
 * media query at hook time. The component must render without throwing
 * even when motion is suppressed — that's the assertion.
 */
function stubReducedMotion(reduce: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  });
}

describe("reduced-motion", () => {
  afterEach(() => {
    __resetChatStoreForTests();
  });

  it("DockShell renders cleanly when prefers-reduced-motion is set", () => {
    stubReducedMotion(true);
    const { getByTestId } = render(<DockShell />);
    expect(getByTestId("dock-shell")).toBeInTheDocument();
  });

  it("DockShell renders cleanly when motion is allowed", () => {
    stubReducedMotion(false);
    const { getByTestId } = render(<DockShell />);
    expect(getByTestId("dock-shell")).toBeInTheDocument();
  });
});
