import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Onboarding } from "@/screens/Onboarding";
import { __resetOnboardingStoreForTests, useOnboarding } from "@/lib/store/onboarding";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "desktop_pick_watch_dir") return null;
    return {};
  }),
}));

vi.mock("@/lib/main-ipc", async () => {
  return {
    DEFAULT_GENERAL: {
      theme: "auto",
      language: "en",
      sound_on_critical: true,
    },
    DEFAULT_NOTIFICATIONS: {
      notification_level: "important",
      sound_volume: 70,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "",
      respect_focus_mode: true,
    },
    DEFAULT_AI: {
      byok_present: false,
      byok_preview: "",
      model_routing: "auto",
      spend_today_usd: 0,
      spend_cap_usd: 300,
    },
    DEFAULT_PRIVACY: { telemetry_optout: false, local_only_mode: false },
    onboardingOpenRepo: vi.fn(async (path: string) => ({
      id: "repo-id-1",
      path,
      name: "fixture-repo",
      already_registered: false,
    })),
    onboardingProgress: vi.fn(async () => ({
      stage: "done",
      percent: 1,
      symbol_count: 12,
    })),
    completeOnboarding: vi.fn(async () => ({ onboarded: true })),
    installShellHooks: vi.fn(async (kind: string) => ({
      installed_for: [kind],
      daemon_listening: false,
    })),
    installVscodeExtension: vi.fn(async () => ({
      success: true,
      message: "VS Code extension queued",
    })),
    configureHttpProxy: vi.fn(async () => ({
      success: true,
      message: "HTTP proxy queued",
    })),
    hideDock: vi.fn(async () => {}),
    openMainWindow: vi.fn(async () => {}),
    isOnboarded: vi.fn(async () => ({ onboarded: false })),
  };
});

describe("Onboarding (3-screen flow)", () => {
  beforeEach(() => {
    __resetOnboardingStoreForTests();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("completes drop → power-ups → ready and calls complete_onboarding", async () => {
    render(<Onboarding />);

    // Step 1 — drop a fixture path.
    expect(screen.getByTestId("onboarding-step-drop")).toBeInTheDocument();
    const zone = screen.getByTestId("repo-dropzone");

    const dt = {
      items: [{ getAsFile: () => null, path: "/tmp/fixture-repo" }],
      getData: () => "",
    } as unknown as DataTransfer;

    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: dt });
    });

    // Progress hits "done" via mocked onboardingProgress → store auto-advances.
    await waitFor(() =>
      expect(screen.getByTestId("onboarding-step-powerups")).toBeInTheDocument(),
    );

    // Step 2 — toggle one power-up + skip the rest.
    const watchTerminal = screen.getByTestId("powerup-watchTerminal-switch");
    await act(async () => {
      fireEvent.click(watchTerminal);
    });
    expect(useOnboarding.getState().powerUps.watchTerminal).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByTestId("onboarding-powerups-skip"));
    });

    // Step 3 — Ready CTA fires complete_onboarding through the IPC layer.
    await waitFor(() =>
      expect(screen.getByTestId("onboarding-step-ready")).toBeInTheDocument(),
    );

    const mainIpc = await import("@/lib/main-ipc");
    await act(async () => {
      fireEvent.click(screen.getByTestId("onboarding-ask-inari"));
    });
    expect(mainIpc.completeOnboarding).toHaveBeenCalled();
  });
});
