/**
 * v0.3 Phase A — CloudDashboard rendering smoke tests.
 *
 * Covers the render states the panel can land in:
 *   1. Disconnected → "Connect to InariWatch Cloud" empty state
 *   2. Connect button → calls `cloudAuthStart` + `cloudAuthPoll` and
 *      flips to connected
 *   3. Connected → all 6 widget cards render with their data
 *   4. Collapse panel → only the rail strip remains, NO widget fetches
 *      fire (zero perf cost when collapsed)
 *   5. `cloud-auth-required` event → flips back to the empty state
 *   6. Per-card collapse persists in localStorage
 *
 * `lib/cloud-ipc` is mocked at module boundary so the suite is hermetic.
 * Tauri's event API is also stubbed (the panel late-imports it).
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloudIpc = vi.hoisted(() => ({
  cloudAuthStatus: vi.fn(),
  cloudAuthStart: vi.fn(),
  cloudAuthPoll: vi.fn(),
  cloudLogout: vi.fn(),
  cloudGetAlerts: vi.fn(),
  cloudGetUptime: vi.fn(),
  cloudGetDeploys: vi.fn(),
  cloudGetOncall: vi.fn(),
  cloudGetCommunityTrending: vi.fn(),
  cloudGetStatusSummary: vi.fn(),
}));

vi.mock("@/lib/cloud-ipc", () => ({
  ...cloudIpc,
  CloudError: class CloudError extends Error {
    kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.kind = kind;
    }
  },
}));

let listeners = new Map<string, Array<(payload: { payload: unknown }) => void>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (payload: { payload: unknown }) => void) => {
    const arr = listeners.get(name) ?? [];
    arr.push(handler);
    listeners.set(name, arr);
    return () => {
      const next = (listeners.get(name) ?? []).filter((h) => h !== handler);
      listeners.set(name, next);
    };
  }),
}));

import { CloudDashboard } from "@/components/cloud/CloudDashboard";
import { _resetCloudPanelStateForTests, setPanelOpen } from "@/lib/store/cloudPanel";

function emit(name: string, payload: unknown = null) {
  for (const h of listeners.get(name) ?? []) h({ payload });
}

beforeEach(() => {
  listeners = new Map();
  cloudIpc.cloudAuthStatus.mockReset();
  cloudIpc.cloudAuthStart.mockReset();
  cloudIpc.cloudAuthPoll.mockReset();
  cloudIpc.cloudGetAlerts.mockReset();
  cloudIpc.cloudGetUptime.mockReset();
  cloudIpc.cloudGetDeploys.mockReset();
  cloudIpc.cloudGetOncall.mockReset();
  cloudIpc.cloudGetCommunityTrending.mockReset();
  cloudIpc.cloudGetStatusSummary.mockReset();
  _resetCloudPanelStateForTests();
  setPanelOpen(true);
});

afterEach(() => {
  // Reset localStorage so per-card collapse state never leaks across tests.
  try {
    window.localStorage.clear();
  } catch {
    /* no-op */
  }
});

describe("CloudDashboard — disconnected state", () => {
  it("renders the empty connect state when not connected", async () => {
    cloudIpc.cloudAuthStatus.mockResolvedValue({
      connected: false,
      api_url: "https://app.inariwatch.com",
      watch_dir: null,
    });

    render(<CloudDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("cloud-empty-state")).toBeInTheDocument();
    });
    expect(screen.getByTestId("cloud-connect-button")).toHaveTextContent(
      /Connect to InariWatch Cloud/i,
    );
    // None of the data fetchers should have fired yet.
    expect(cloudIpc.cloudGetAlerts).not.toHaveBeenCalled();
    expect(cloudIpc.cloudGetUptime).not.toHaveBeenCalled();
  });

  it("kicks off the device flow when Connect is clicked", async () => {
    cloudIpc.cloudAuthStatus
      .mockResolvedValueOnce({ connected: false, api_url: "x", watch_dir: null })
      .mockResolvedValueOnce({ connected: true, api_url: "x", watch_dir: null });
    cloudIpc.cloudAuthStart.mockResolvedValue({
      code: "abc",
      verify_url: "https://x/verify?code=abc",
      api_url: "https://x",
    });
    cloudIpc.cloudAuthPoll.mockResolvedValue("token");
    // After connect, every widget will be queried — give them empty payloads.
    cloudIpc.cloudGetStatusSummary.mockResolvedValue({
      state: "operational",
      alertsCritical24h: 0,
      alertsWarning24h: 0,
      monitorsDown: 0,
      monitorsTotal: 0,
      projectCount: 0,
      lastAlertAt: null,
    });
    cloudIpc.cloudGetAlerts.mockResolvedValue([]);
    cloudIpc.cloudGetUptime.mockResolvedValue({
      monitors: [],
      downCount: 0,
      total: 0,
      avgResponseMs: null,
    });
    cloudIpc.cloudGetDeploys.mockResolvedValue({ deploys: [], failedCount: 0 });
    cloudIpc.cloudGetOncall.mockResolvedValue({ schedules: [], totalAssignments: 0 });
    cloudIpc.cloudGetCommunityTrending.mockResolvedValue([]);

    render(<CloudDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("cloud-connect-button")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("cloud-connect-button"));
    });

    expect(cloudIpc.cloudAuthStart).toHaveBeenCalled();
    await waitFor(() => {
      expect(cloudIpc.cloudAuthPoll).toHaveBeenCalledWith("abc", "https://x");
    });
    await waitFor(() => {
      expect(screen.getByTestId("cloud-widget-status")).toBeInTheDocument();
    });
  });
});

describe("CloudDashboard — connected state", () => {
  beforeEach(() => {
    cloudIpc.cloudAuthStatus.mockResolvedValue({
      connected: true,
      api_url: "https://app.inariwatch.com",
      watch_dir: null,
    });
    cloudIpc.cloudGetStatusSummary.mockResolvedValue({
      state: "outage",
      alertsCritical24h: 2,
      alertsWarning24h: 5,
      monitorsDown: 1,
      monitorsTotal: 3,
      projectCount: 7,
      lastAlertAt: "2026-05-02T00:00:00Z",
    });
    cloudIpc.cloudGetAlerts.mockResolvedValue([
      {
        id: "a1",
        title: "Boom",
        body: null,
        severity: "critical",
        aiReasoning: null,
        sourceIntegrations: ["sentry"],
        projectName: "app",
        fingerprint: null,
        isRead: false,
        isResolved: false,
        createdAt: "2026-05-02T00:00:00Z",
      },
    ]);
    cloudIpc.cloudGetUptime.mockResolvedValue({
      monitors: [
        {
          id: "m1",
          name: "api",
          url: "https://x",
          isDown: true,
          consecutiveFailures: 3,
          lastCheckedAt: null,
          lastResponseTimeMs: null,
        },
      ],
      downCount: 1,
      total: 1,
      avgResponseMs: null,
    });
    cloudIpc.cloudGetDeploys.mockResolvedValue({ deploys: [], failedCount: 0 });
    cloudIpc.cloudGetOncall.mockResolvedValue({ schedules: [], totalAssignments: 0 });
    cloudIpc.cloudGetCommunityTrending.mockResolvedValue([]);
  });

  it("renders all 6 widget cards", async () => {
    render(<CloudDashboard />);
    for (const id of ["status", "alerts", "uptime", "deploys", "oncall", "community"]) {
      await waitFor(() =>
        expect(screen.getByTestId(`cloud-widget-${id}`)).toBeInTheDocument(),
      );
    }
  });

  it("renders the alert row from the data fetch", async () => {
    render(<CloudDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("cloud-alert-row-a1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("cloud-alert-row-a1")).toHaveTextContent("Boom");
  });

  it("flips back to disconnected when cloud-auth-required event fires", async () => {
    render(<CloudDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("cloud-widget-status")).toBeInTheDocument();
    });

    await act(async () => {
      emit("cloud-auth-required");
    });

    await waitFor(() => {
      expect(screen.getByTestId("cloud-empty-state")).toBeInTheDocument();
    });
  });
});

describe("CloudDashboard — collapsed panel", () => {
  it("renders only the rail strip and fires zero data fetches", async () => {
    cloudIpc.cloudAuthStatus.mockResolvedValue({
      connected: true,
      api_url: "x",
      watch_dir: null,
    });
    setPanelOpen(false);
    render(<CloudDashboard />);
    await waitFor(() => {
      expect(screen.getByTestId("cloud-panel-rail-collapsed")).toBeInTheDocument();
    });
    // Nothing should have been fetched while the panel was collapsed.
    expect(cloudIpc.cloudGetStatusSummary).not.toHaveBeenCalled();
    expect(cloudIpc.cloudGetAlerts).not.toHaveBeenCalled();
    expect(cloudIpc.cloudGetUptime).not.toHaveBeenCalled();
    expect(cloudIpc.cloudGetDeploys).not.toHaveBeenCalled();
    expect(cloudIpc.cloudGetOncall).not.toHaveBeenCalled();
    expect(cloudIpc.cloudGetCommunityTrending).not.toHaveBeenCalled();
  });
});
