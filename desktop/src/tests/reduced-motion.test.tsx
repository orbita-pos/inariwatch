import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DockShell } from "@/components/dock/DockShell";

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
