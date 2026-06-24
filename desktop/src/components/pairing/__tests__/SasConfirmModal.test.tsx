import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SasConfirmModal, type SasPendingState } from "@/components/pairing/SasConfirmModal";

const STATE: SasPendingState = {
  challenge_id: "ch-1",
  channel: "whatsapp",
  identifier_redacted: "+52 ••••5678",
  display_name: "Jesus Phone",
  sas_digits: "482619",
};

describe("SasConfirmModal", () => {
  it("renders SAS digits in spaced format", () => {
    render(
      <SasConfirmModal
        open={true}
        state={STATE}
        onMatch={() => undefined}
        onReject={() => undefined}
        onOpenChange={() => undefined}
      />,
    );
    expect(screen.getByTestId("sas-digits")).toHaveTextContent("482 619");
  });

  it("Match button dispatches onMatch with challenge id", () => {
    const onMatch = vi.fn();
    render(
      <SasConfirmModal
        open={true}
        state={STATE}
        onMatch={onMatch}
        onReject={() => undefined}
        onOpenChange={() => undefined}
      />,
    );
    screen.getByTestId("sas-match").click();
    expect(onMatch).toHaveBeenCalledWith("ch-1");
  });

  it("Reject button dispatches onReject with challenge id", () => {
    const onReject = vi.fn();
    render(
      <SasConfirmModal
        open={true}
        state={STATE}
        onMatch={() => undefined}
        onReject={onReject}
        onOpenChange={() => undefined}
      />,
    );
    screen.getByTestId("sas-reject").click();
    expect(onReject).toHaveBeenCalledWith("ch-1");
  });

  it("renders 'No pending pairing' when state is null", () => {
    render(
      <SasConfirmModal
        open={true}
        state={null}
        onMatch={() => undefined}
        onReject={() => undefined}
        onOpenChange={() => undefined}
      />,
    );
    expect(screen.getByText(/No pending pairing/)).toBeInTheDocument();
  });
});
