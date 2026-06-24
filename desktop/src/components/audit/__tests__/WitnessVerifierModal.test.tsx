import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WitnessVerifierModal } from "@/components/audit/WitnessVerifierModal";
import type { AuditEntry, VerifyResult } from "@/lib/audit-ui-ipc";

const desktopAuditGet = vi.fn();
const desktopAuditVerify = vi.fn();

vi.mock("@/lib/audit-ui-ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit-ui-ipc")>();
  return {
    ...actual,
    desktopAuditGet: (...args: unknown[]) => desktopAuditGet(...args),
    desktopAuditVerify: (...args: unknown[]) => desktopAuditVerify(...args),
  };
});

function entry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    id: "i-1",
    tool_name: "desktop.read_clipboard",
    session_id: "s-1",
    args_json: '{"k":1}',
    result_json: '{"ok":true}',
    permission: "auto",
    permission_decision: "allow",
    witness_receipt_id: "deadbeefcafebabe",
    started_at_ms: 1_000,
    finished_at_ms: 1_050,
    success: true,
    error: null,
    source: "agent",
    ...overrides,
  };
}

function verify(overrides: Partial<VerifyResult>): VerifyResult {
  return {
    args_hash_match: true,
    result_hash_match: true,
    signature: "not_yet_signed",
    computed_args_sha256: "deadbeefcafebabe",
    recorded_args_sha256: "deadbeefcafebabe",
    computed_result_sha256: "feedfacefeedface",
    recorded_result_sha256: null,
    ...overrides,
  };
}

describe("WitnessVerifierModal", () => {
  beforeEach(() => {
    desktopAuditGet.mockReset();
    desktopAuditVerify.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows green checks for args + result when both hashes match", async () => {
    desktopAuditGet.mockResolvedValue(entry({}));
    desktopAuditVerify.mockResolvedValue(verify({}));

    render(<WitnessVerifierModal invocationId="i-1" onOpenChange={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId("witness-verifier-args")).toHaveAttribute(
        "data-state",
        "ok",
      ),
    );
    expect(screen.getByTestId("witness-verifier-result")).toHaveAttribute(
      "data-state",
      "ok",
    );
  });

  it("shows a fail state when the args hash does not match", async () => {
    desktopAuditGet.mockResolvedValue(entry({}));
    desktopAuditVerify.mockResolvedValue(
      verify({ args_hash_match: false }),
    );

    render(<WitnessVerifierModal invocationId="i-1" onOpenChange={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId("witness-verifier-args")).toHaveAttribute(
        "data-state",
        "fail",
      ),
    );
  });

  it("renders the signature row as a placeholder ○ for not_yet_signed receipts", async () => {
    desktopAuditGet.mockResolvedValue(entry({}));
    desktopAuditVerify.mockResolvedValue(verify({ signature: "not_yet_signed" }));

    render(<WitnessVerifierModal invocationId="i-1" onOpenChange={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId("witness-verifier-signature")).toHaveAttribute(
        "data-state",
        "neutral",
      ),
    );
    // The "pre-S6 / not yet signed" copy is part of what makes the
    // placeholder honest — guard it explicitly so we don't accidentally
    // silently start showing a green checkmark on an unsigned receipt.
    expect(screen.getByTestId("witness-verifier-signature")).toHaveTextContent(
      /pre-s6|not yet signed/i,
    );
  });

  it("treats null result_json as 'nothing to verify' rather than a fail", async () => {
    desktopAuditGet.mockResolvedValue(entry({ result_json: null, success: false, error: "boom" }));
    desktopAuditVerify.mockResolvedValue(
      verify({ result_hash_match: true, computed_result_sha256: null }),
    );

    render(<WitnessVerifierModal invocationId="i-1" onOpenChange={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId("witness-verifier-result")).toHaveAttribute(
        "data-state",
        "neutral",
      ),
    );
  });

  it("closes nothing when invocationId is null (modal stays unmounted)", () => {
    render(<WitnessVerifierModal invocationId={null} onOpenChange={() => {}} />);
    expect(screen.queryByTestId("witness-verifier-modal")).not.toBeInTheDocument();
    expect(desktopAuditGet).not.toHaveBeenCalled();
  });
});
