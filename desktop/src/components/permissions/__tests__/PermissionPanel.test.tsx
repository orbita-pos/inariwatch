import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PermissionPanel } from "@/components/permissions/PermissionPanel";
import type { PermissionListing } from "@/lib/audit-ui-ipc";

const desktopPermissionList = vi.fn();
const desktopPermissionSet = vi.fn();
const desktopPermissionClear = vi.fn();

vi.mock("@/lib/audit-ui-ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit-ui-ipc")>();
  return {
    ...actual,
    desktopPermissionList: (...args: unknown[]) => desktopPermissionList(...args),
    desktopPermissionSet: (...args: unknown[]) => desktopPermissionSet(...args),
    desktopPermissionClear: (...args: unknown[]) => desktopPermissionClear(...args),
  };
});

const LISTING: PermissionListing = {
  rows: [
    {
      name: "desktop.read_clipboard",
      description: "Read the OS clipboard.",
      default_permission: "auto",
      override_level: null,
    },
    {
      name: "desktop.write_clipboard",
      description: "Replace the OS clipboard.",
      default_permission: "confirm",
      override_level: null,
    },
  ],
};

describe("PermissionPanel", () => {
  beforeEach(() => {
    desktopPermissionList.mockReset();
    desktopPermissionSet.mockReset();
    desktopPermissionClear.mockReset();
    desktopPermissionList.mockResolvedValue(LISTING);
    desktopPermissionSet.mockResolvedValue(undefined);
    desktopPermissionClear.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders one row per tool from the permission list", async () => {
    render(<PermissionPanel />);
    await waitFor(() =>
      expect(
        screen.getByTestId("permission-row-desktop.read_clipboard"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("permission-row-desktop.write_clipboard"),
    ).toBeInTheDocument();
  });

  it("clicking a radio level calls desktop_permission_set with that level", async () => {
    render(<PermissionPanel />);
    await waitFor(() =>
      expect(
        screen.getByTestId("permission-row-desktop.read_clipboard"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByTestId("permission-radio-desktop.read_clipboard-confirm"),
    );

    await waitFor(() =>
      expect(desktopPermissionSet).toHaveBeenCalledWith(
        "desktop.read_clipboard",
        "confirm",
      ),
    );
    // Optimistic update flips the row to overridden.
    expect(
      screen.getByTestId("permission-row-desktop.read_clipboard"),
    ).toHaveAttribute("data-overridden", "true");
  });

  it("Reset clears the override via desktop_permission_clear", async () => {
    desktopPermissionList.mockResolvedValueOnce({
      rows: [
        {
          name: "desktop.read_clipboard",
          description: "Read the OS clipboard.",
          default_permission: "auto",
          override_level: "deny",
        },
      ],
    });

    render(<PermissionPanel />);

    await waitFor(() =>
      expect(
        screen.getByTestId("permission-row-desktop.read_clipboard"),
      ).toHaveAttribute("data-overridden", "true"),
    );

    fireEvent.click(screen.getByTestId("permission-reset-desktop.read_clipboard"));

    await waitFor(() =>
      expect(desktopPermissionClear).toHaveBeenCalledWith(
        "desktop.read_clipboard",
      ),
    );
  });
});
