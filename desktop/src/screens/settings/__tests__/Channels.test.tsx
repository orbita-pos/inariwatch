import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsChannels } from "@/screens/settings/Channels";

const mocks = vi.hoisted(() => ({
  pairingList: vi.fn<() => Promise<unknown[]>>(),
  pairingGenerate: vi.fn<(kind: string) => Promise<unknown>>(),
  pairingRevoke: vi.fn<(id: string) => Promise<void>>(),
  pairingConfirm: vi.fn<(id: string, approve: boolean) => Promise<unknown>>(),
}));

vi.mock("@/lib/main-ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/main-ipc")>();
  return {
    ...actual,
    pairingList: mocks.pairingList,
    pairingGenerate: mocks.pairingGenerate,
    pairingRevoke: mocks.pairingRevoke,
    pairingConfirm: mocks.pairingConfirm,
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

describe("Settings → Channels", () => {
  beforeEach(() => {
    mocks.pairingList.mockReset();
    mocks.pairingGenerate.mockReset();
    mocks.pairingRevoke.mockReset();
    mocks.pairingConfirm.mockReset();
    mocks.pairingList.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads paired list on mount and renders the three channel sections", async () => {
    render(<SettingsChannels />);
    expect(screen.getByTestId("settings-section-channels")).toBeInTheDocument();
    expect(screen.getByTestId("channel-whatsapp")).toBeInTheDocument();
    expect(screen.getByTestId("channel-telegram")).toBeInTheDocument();
    expect(screen.getByTestId("channel-slack")).toBeInTheDocument();
    await waitFor(() => expect(mocks.pairingList).toHaveBeenCalledTimes(1));
  });

  it("Pair a phone button calls generate and shows the modal", async () => {
    mocks.pairingGenerate.mockResolvedValue({
      id: "id-1",
      code: "ABCDEFGH",
      code_chunked: "ABCD-EFGH",
      kind: "phone",
      created_at_ms: Date.now(),
      expires_at_ms: Date.now() + 60 * 60 * 1000,
    });
    render(<SettingsChannels />);
    screen.getByTestId("channel-pair-phone").click();
    await waitFor(() => expect(mocks.pairingGenerate).toHaveBeenCalledWith("phone"));
    await waitFor(() =>
      expect(screen.queryByTestId("pairing-code-modal")).toBeInTheDocument(),
    );
  });

  it("displays an error banner when pairingList rejects", async () => {
    mocks.pairingList.mockRejectedValueOnce(new Error("workspace not selected"));
    render(<SettingsChannels />);
    await waitFor(() =>
      expect(screen.getByTestId("channels-error")).toHaveTextContent(
        "workspace not selected",
      ),
    );
  });
});
