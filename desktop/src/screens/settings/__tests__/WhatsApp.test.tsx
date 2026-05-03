// v0.3 S5 (Baileys rewrite) — Settings → WhatsApp tests.
//
// Mocks:
//   - `@tauri-apps/api/core` invoke   — IPC calls land here.
//   - `@tauri-apps/api/event` listen  — event subscribers we count.
//   - `qrcode.react`                  — render a sentinel <span> so we
//                                       don't depend on qrcode internals.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => (
    <span data-testid="mock-qr">QR:{value}</span>
  ),
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

let qrCallback: ((event: { payload: { account_id: string; qr: string; ts_ms: number } }) => void) | null = null;
let linkedCallback: ((event: { payload: { account_id: string; self_jid: string; ts_ms: number } }) => void) | null = null;
const listenMock = vi.fn(async (event: string, cb: unknown) => {
  if (event === "whatsapp:qr-update") qrCallback = cb as typeof qrCallback;
  if (event === "whatsapp:linked") linkedCallback = cb as typeof linkedCallback;
  return () => undefined;
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import { SettingsWhatsApp } from "../WhatsApp";

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockClear();
  qrCallback = null;
  linkedCallback = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SettingsWhatsApp", () => {
  it("renders empty state when no accounts are linked", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "whatsapp_list_accounts") return [];
      return undefined;
    });
    await act(async () => {
      render(<SettingsWhatsApp />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("whatsapp-empty-state")).toBeInTheDocument();
    });
    expect(screen.getByText(/No WhatsApp accounts linked/i)).toBeInTheDocument();
  });

  it("renders the TOS warning banner", async () => {
    invokeMock.mockImplementation(async () => []);
    await act(async () => {
      render(<SettingsWhatsApp />);
    });
    expect(screen.getByTestId("whatsapp-tos-warning")).toBeInTheDocument();
    expect(screen.getByText(/TOS gray area/i)).toBeInTheDocument();
  });

  it("lists accounts returned by whatsapp_list_accounts IPC", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "whatsapp_list_accounts") {
        return [
          {
            account_id: "personal-1",
            label: "Personal",
            self_jid: "5215551234567@s.whatsapp.net",
            status: "connected",
            last_qr_at_ms: null,
            last_linked_at_ms: Date.now(),
          },
        ];
      }
      return undefined;
    });
    await act(async () => {
      render(<SettingsWhatsApp />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("whatsapp-account-personal-1")).toBeInTheDocument();
    });
    expect(screen.getByText("Personal")).toBeInTheDocument();
    expect(screen.getByText("5215551234567@s.whatsapp.net")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("Add account opens the QR modal and renders the QR on whatsapp:qr-update event", async () => {
    // Default resolution: list_accounts returns []. Specific mockResolvedValueOnce
    // overrides for non-list calls. Component refreshes on every event so
    // we can't predict exact call counts.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "whatsapp_list_accounts") return [];
      return undefined;
    });
    await act(async () => {
      render(<SettingsWhatsApp />);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("whatsapp-add-account"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("whatsapp-pair-modal")).toBeInTheDocument();
    });

    // No QR yet — render shows "Waiting for QR…".
    expect(screen.getByText(/Waiting for QR/i)).toBeInTheDocument();

    // Sidecar emits a qr_update event for the pairing account.
    expect(qrCallback).toBeTruthy();
    await act(async () => {
      qrCallback?.({
        payload: {
          // Account id is `account-<base36 timestamp>` — match the modal's
          // current pairingFor by reading what the component dispatched.
          account_id: getDispatchedAccountId(),
          qr: "MOCK-QR-STR",
          ts_ms: Date.now(),
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("mock-qr")).toBeInTheDocument();
    });
    expect(screen.getByTestId("mock-qr")).toHaveTextContent("QR:MOCK-QR-STR");
  });

  it("auto-closes the modal on whatsapp:linked event", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "whatsapp_list_accounts") return [];
      return undefined;
    });
    await act(async () => {
      render(<SettingsWhatsApp />);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("whatsapp-add-account"));
    });
    expect(screen.getByTestId("whatsapp-pair-modal")).toBeInTheDocument();

    expect(linkedCallback).toBeTruthy();
    await act(async () => {
      linkedCallback?.({
        payload: {
          account_id: getDispatchedAccountId(),
          self_jid: "5215551234567@s.whatsapp.net",
          ts_ms: Date.now(),
        },
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("whatsapp-pair-modal")).not.toBeInTheDocument();
    });
  });

  it("Disconnect calls whatsapp_logout for the right account", async () => {
    let listCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "whatsapp_list_accounts") {
        listCalls += 1;
        // First list call returns the account; subsequent returns []
        // (so the test can verify the row is removed after logout if
        // we want to extend it later).
        return listCalls === 1
          ? [
              {
                account_id: "personal-1",
                label: "Personal",
                self_jid: "5215551234567@s.whatsapp.net",
                status: "connected",
                last_qr_at_ms: null,
                last_linked_at_ms: Date.now(),
              },
            ]
          : [];
      }
      return undefined;
    });
    await act(async () => {
      render(<SettingsWhatsApp />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("whatsapp-disconnect-personal-1")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("whatsapp-disconnect-personal-1"));
    });
    expect(invokeMock).toHaveBeenCalledWith("whatsapp_logout", {
      accountId: "personal-1",
    });
  });
});

// Helper — the component generates account IDs like `account-<base36>`.
// Pull whichever ID was passed to whatsapp_login_start so the test event
// can address the right modal session.
function getDispatchedAccountId(): string {
  for (const call of invokeMock.mock.calls) {
    if (call[0] === "whatsapp_login_start") {
      return (call[1] as { accountId: string }).accountId;
    }
  }
  return "unknown";
}
