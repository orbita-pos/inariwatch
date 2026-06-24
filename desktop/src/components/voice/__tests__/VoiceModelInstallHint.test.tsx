/**
 * S9 — VoiceModelInstallHint per-OS rendering.
 *
 * Drives the platformOverride prop directly so jsdom doesn't have to
 * have any particular `userAgentData` set. Asserts each OS surfaces
 * its expected install command + the model URL.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VoiceModelInstallHint } from "../VoiceModelInstallHint";

describe("VoiceModelInstallHint", () => {
  it("shows brew install on macOS", () => {
    render(<VoiceModelInstallHint platformOverride="mac" />);
    expect(screen.getByTestId("voice-install-hint")).toHaveAttribute("data-platform", "mac");
    expect(screen.getByText(/brew install whisper-cpp/)).toBeInTheDocument();
  });

  it("shows release ZIP link on Windows", () => {
    render(<VoiceModelInstallHint platformOverride="win" />);
    expect(screen.getByTestId("voice-install-hint")).toHaveAttribute("data-platform", "win");
    expect(
      screen.getByText(/github\.com\/ggerganov\/whisper\.cpp\/releases/),
    ).toBeInTheDocument();
  });

  it("shows build-from-source on Linux", () => {
    render(<VoiceModelInstallHint platformOverride="linux" />);
    expect(screen.getByTestId("voice-install-hint")).toHaveAttribute("data-platform", "linux");
    expect(screen.getByText(/git clone .*whisper\.cpp/)).toBeInTheDocument();
  });

  it("references the ggml-base.en model URL on every platform", () => {
    for (const p of ["win", "mac", "linux"] as const) {
      const { unmount } = render(<VoiceModelInstallHint platformOverride={p} />);
      expect(
        screen.getAllByText(/ggml-base\.en\.bin/i).length,
      ).toBeGreaterThan(0);
      unmount();
    }
  });

  it("calls clipboard.writeText when copy buttons are clicked", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText } },
    });
    render(<VoiceModelInstallHint platformOverride="mac" />);
    const copyButton = screen.getByTestId("voice-install-install-0-copy");
    fireEvent.click(copyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("brew install whisper-cpp"));
  });
});
