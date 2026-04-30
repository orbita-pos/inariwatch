import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock — Framer Motion's `useReducedMotion` is a singleton
// subscription bound to `window.matchMedia` at first call. Toggling
// matchMedia between tests doesn't reach the cached MotionValue, so we
// mock the hook directly. The wrapper variable is `vi.hoisted`'d so
// the `vi.mock` factory below can close over it without a TDZ error.
const { mockUseReducedMotion } = vi.hoisted(() => ({
  mockUseReducedMotion: vi.fn<() => boolean | null>(() => false),
}));

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return {
    ...actual,
    useReducedMotion: mockUseReducedMotion,
  };
});

import { GateChecklist } from "@/components/GateChecklist";
import { GATE_NAMES, type GateResult } from "@/types/alert";

function buildGates(overrides: Partial<GateResult>[] = []): GateResult[] {
  return GATE_NAMES.map((name, idx) => ({
    id: String(idx + 1),
    name,
    status: idx % 5 === 0 ? "fail" : "pass",
    ...(overrides.find((o) => o.name === name) ?? {}),
  }));
}

describe("GateChecklist", () => {
  beforeEach(() => {
    mockUseReducedMotion.mockReturnValue(false);
  });

  it("renders 17 gates with the stagger animation enabled", async () => {
    render(<GateChecklist gates={buildGates()} />);

    const checklist = screen.getByTestId("gate-checklist");
    expect(checklist).toHaveAttribute("data-gate-count", "17");
    expect(checklist).toHaveAttribute("data-stagger", "on");

    await waitFor(() => {
      expect(screen.getAllByTestId("gate-row")).toHaveLength(17);
    });

    const rows = screen.getAllByTestId("gate-row");
    expect(rows[0]!).toHaveAttribute("data-gate-id", "1");
    expect(rows[0]!).toHaveTextContent(/auto.merge.enabled/);
  });

  it("removes the stagger but keeps all 17 rows under reduced-motion", () => {
    mockUseReducedMotion.mockReturnValue(true);

    render(<GateChecklist gates={buildGates()} />);

    const checklist = screen.getByTestId("gate-checklist");
    expect(checklist).toHaveAttribute("data-stagger", "off");
    // No waitFor — every row must be in the DOM on the first render.
    expect(screen.getAllByTestId("gate-row")).toHaveLength(17);

    // Failed rows surface their detail when one is supplied.
    const withDetail = render(
      <GateChecklist
        gates={buildGates([
          {
            name: "security_scan",
            status: "fail",
            detail: "1 HIGH finding: SSRF",
          },
        ])}
      />,
    );
    expect(withDetail.getAllByTestId("gate-row-detail")[0]).toHaveTextContent(
      /SSRF/,
    );
  });
});
