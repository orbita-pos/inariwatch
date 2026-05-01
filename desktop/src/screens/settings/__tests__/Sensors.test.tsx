import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetSettingsStoreForTests, useSettings } from "@/lib/store/settings";
import { SettingsSensors } from "@/screens/settings/Sensors";
import type { SensorsState } from "@/lib/main-ipc";

const setSensorEnabledMock = vi.fn();

vi.mock("@/lib/main-ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/main-ipc")>();
  return {
    ...actual,
    setSensorEnabled: (...args: unknown[]) => setSensorEnabledMock(...args),
    installShellHooks: vi.fn(async () => ({ installed_for: ["zsh"], daemon_listening: false })),
    uninstallShellHooks: vi.fn(async () => ({ installed_for: [], daemon_listening: false })),
  };
});

const SENSORS_FIXTURE: SensorsState = {
  fs_enabled: true,
  mcp_always_on: true,
  shell_installed: [],
  git_hooks_count: 0,
  http_proxy_enabled: false,
  http_proxy_port: 9876,
  substrate_any_repo: false,
};

describe("SettingsSensors", () => {
  beforeEach(() => {
    __resetSettingsStoreForTests();
    setSensorEnabledMock.mockReset();
    setSensorEnabledMock.mockResolvedValue({
      ...SENSORS_FIXTURE,
      fs_enabled: false,
    });
    useSettings.setState({ sensors: SENSORS_FIXTURE });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("toggling FS sensor calls setSensorEnabled and persists optimistically", async () => {
    render(<SettingsSensors />);

    const fsToggle = screen.getByTestId("sensor-toggle-fs");
    expect(fsToggle).toHaveAttribute("aria-checked", "true");

    await act(async () => {
      fireEvent.click(fsToggle);
    });

    expect(setSensorEnabledMock).toHaveBeenCalledWith("fs", false);
    // Optimistic state flipped + reconciled with server response.
    expect(useSettings.getState().sensors?.fs_enabled).toBe(false);
  });
});
