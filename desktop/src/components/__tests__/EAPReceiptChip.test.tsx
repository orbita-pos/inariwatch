import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EAPReceiptChip } from "@/components/EAPReceiptChip";
import type { EapReceiptDto } from "@/lib/dock-ipc";

const RECEIPT: EapReceiptDto = {
  receiptId: "9af3c8b2d6e5f4c3a2b1d0e9f8c7b6a59f1c3a8b7d6e5f4c3a2b1d0e9f8c7b6a",
  remediationSessionId: "sess-1",
  merkleRoot:
    "9af3c8b2d6e5f4c3a2b1d0e9f8c7b6a59f1c3a8b7d6e5f4c3a2b1d0e9f8c7b6a",
  signature: "ed25519:0123456789abcdef",
  signed: true,
  promptHash: "phash_xyz",
  systemPrompt: "You are Inari, an AI fix engineer.",
  toolsCalledJson: JSON.stringify([
    { name: "read_file", args: { path: "src/main.rs" } },
    { name: "search_codebase", args: { query: "off_by_one" } },
  ]),
  filesReadJson: JSON.stringify(["src/main.rs", "tests/main.rs"]),
  model: "gpt-5.4",
  recordingId: "rec_abc",
  attestor: "inariwatch",
  createdAtMs: 1_700_000_000_000,
};

describe("EAPReceiptChip", () => {
  it("renders the unsigned affordance when no receipt is supplied", () => {
    render(<EAPReceiptChip receipt={null} />);
    const chip = screen.getByTestId("eap-receipt-chip");
    expect(chip).toHaveAttribute("data-eap-state", "unsigned");
    expect(chip).toHaveTextContent(/unsigned/i);
  });

  it("renders the truncated Merkle root and opens detail dialog on click", () => {
    render(<EAPReceiptChip receipt={RECEIPT} />);
    const chip = screen.getByTestId("eap-receipt-chip");
    expect(chip).toHaveAttribute("data-eap-state", "signed");
    // Truncation: 6 hex prefix + "…" + 4 hex suffix.
    expect(chip).toHaveTextContent("9af3c8");
    expect(chip).toHaveTextContent("b6a");

    fireEvent.click(chip);

    const detail = screen.getByTestId("eap-receipt-detail");
    expect(detail).toBeInTheDocument();
    expect(detail).toHaveTextContent(/Merkle root/i);
    expect(detail).toHaveTextContent(/Tools called/i);
    expect(detail).toHaveTextContent(/read_file/);
    expect(detail).toHaveTextContent(/search_codebase/);
    expect(detail).toHaveTextContent(/Files read/i);
    expect(detail).toHaveTextContent(/src\/main\.rs/);
    expect(detail).toHaveTextContent(/gpt-5\.4/);

    // Verifier deep link goes to verify.inariwatch.com with the
    // receipt id encoded in the path.
    const link = screen.getByTestId("eap-receipt-chip-verify-link");
    expect(link).toHaveAttribute(
      "href",
      `https://verify.inariwatch.com/r/${encodeURIComponent(RECEIPT.receiptId)}`,
    );
  });

  it("falls back gracefully when tools/files JSON is malformed", () => {
    render(
      <EAPReceiptChip
        receipt={{
          ...RECEIPT,
          toolsCalledJson: "{not-json",
          filesReadJson: "also-not-json",
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("eap-receipt-chip"));
    const detail = screen.getByTestId("eap-receipt-detail");
    // Bad JSON must not crash the popover; the fields are simply absent.
    expect(detail).toBeInTheDocument();
    expect(detail).not.toHaveTextContent(/read_file/);
  });
});
