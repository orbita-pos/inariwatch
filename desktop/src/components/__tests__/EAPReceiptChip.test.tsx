import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EAPReceiptChip } from "@/components/EAPReceiptChip";
import type { EapReceiptDto } from "@/lib/dock-ipc";

// Sesión 28 — the Export button calls `invoke("export_eap_receipt")`.
// In the jsdom test environment we mock @tauri-apps/api/core so the
// chip's React tree can mount + exercise the flow without bridging to
// the real Tauri runtime. The native save-dialog is server-side
// (handled inside the Rust IPC command), so we don't need to mock
// any dialog plugin here — that's exercised by the Rust integration
// tests, not React.
//
// `vi.hoisted` so the mocked reference survives Vitest's module
// rewrite — referencing an outer `let` from inside `vi.mock`
// factories is the recommended pattern.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, payload?: unknown) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

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
  beforeEach(() => {
    mocks.invoke.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  // ── Sesión 28 — Export receipt button ─────────────────────────────

  it("renders the Export receipt button when a receipt is present", () => {
    render(<EAPReceiptChip receipt={RECEIPT} />);
    fireEvent.click(screen.getByTestId("eap-receipt-chip"));
    const exportBtn = screen.getByTestId("eap-receipt-chip-export");
    expect(exportBtn).toBeInTheDocument();
    expect(exportBtn).toHaveTextContent(/Export receipt/i);
  });

  it("calls export_eap_receipt and surfaces a Saved confirmation when the file is written", async () => {
    mocks.invoke.mockResolvedValueOnce({
      path: "/tmp/inari-receipt.eap.json",
      has_public_key: true,
    });

    render(<EAPReceiptChip receipt={RECEIPT} />);
    fireEvent.click(screen.getByTestId("eap-receipt-chip"));
    fireEvent.click(screen.getByTestId("eap-receipt-chip-export"));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("export_eap_receipt", {
        args: { session_id: RECEIPT.remediationSessionId },
      });
    });

    const status = await screen.findByTestId("eap-receipt-chip-export-status");
    expect(status).toHaveTextContent(/Saved\./);
    expect(status).toHaveTextContent(/inari verify/);
  });

  it("returns to idle (no status row) when the user cancels the save dialog", async () => {
    // Backend signals cancellation by resolving with `null`.
    mocks.invoke.mockResolvedValueOnce(null);

    render(<EAPReceiptChip receipt={RECEIPT} />);
    fireEvent.click(screen.getByTestId("eap-receipt-chip"));
    fireEvent.click(screen.getByTestId("eap-receipt-chip-export"));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.queryByTestId("eap-receipt-chip-export-status"),
    ).toBeNull();
  });

  it("surfaces a Merkle-only hint when the attestor pubkey is unavailable", async () => {
    mocks.invoke.mockResolvedValueOnce({
      path: "/tmp/inari-receipt.eap.json",
      has_public_key: false,
    });

    render(<EAPReceiptChip receipt={RECEIPT} />);
    fireEvent.click(screen.getByTestId("eap-receipt-chip"));
    fireEvent.click(screen.getByTestId("eap-receipt-chip-export"));

    const status = await screen.findByTestId("eap-receipt-chip-export-status");
    expect(status).toHaveTextContent(/Merkle-only/);
  });

  it("renders an inline error when the backend export fails", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("disk full"));

    render(<EAPReceiptChip receipt={RECEIPT} />);
    fireEvent.click(screen.getByTestId("eap-receipt-chip"));
    fireEvent.click(screen.getByTestId("eap-receipt-chip-export"));

    const status = await screen.findByTestId("eap-receipt-chip-export-status");
    expect(status).toHaveTextContent(/Export failed/);
    expect(status).toHaveTextContent(/disk full/);
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
