import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PairingCodeModal } from "@/components/pairing/PairingCodeModal";
import type { PendingPairingDto } from "@/lib/main-ipc";

const PENDING: PendingPairingDto = {
  id: "id-1",
  code: "ABCDEFGH",
  code_chunked: "ABCD-EFGH",
  kind: "phone",
  created_at_ms: Date.now(),
  expires_at_ms: Date.now() + 60 * 60 * 1000,
};

describe("PairingCodeModal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PENDING.created_at_ms));
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders chunked code when open with a pending payload", () => {
    render(
      <PairingCodeModal
        open={true}
        pending={PENDING}
        onOpenChange={() => undefined}
      />,
    );
    expect(screen.getByTestId("pairing-code")).toHaveTextContent("ABCD-EFGH");
  });

  it("countdown updates after a tick", () => {
    render(
      <PairingCodeModal
        open={true}
        pending={PENDING}
        onOpenChange={() => undefined}
      />,
    );
    const before = screen.getByTestId("pairing-countdown").textContent ?? "";
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const after = screen.getByTestId("pairing-countdown").textContent ?? "";
    expect(after).not.toEqual(before);
  });

  it("copy button writes the un-chunked code to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <PairingCodeModal
        open={true}
        pending={PENDING}
        onOpenChange={() => undefined}
      />,
    );
    screen.getByTestId("pairing-copy").click();
    expect(writeText).toHaveBeenCalledWith("ABCDEFGH");
  });

  it("renders 'Generating…' when no pending payload", () => {
    render(
      <PairingCodeModal
        open={true}
        pending={null}
        onOpenChange={() => undefined}
      />,
    );
    expect(screen.getByText(/Generating/)).toBeInTheDocument();
  });
});
