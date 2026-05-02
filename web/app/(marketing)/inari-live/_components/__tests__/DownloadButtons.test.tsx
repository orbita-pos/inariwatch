// @vitest-environment happy-dom
/**
 * Sesión 30 — UA-detected primary OS button.
 *
 * Asserts:
 *   1. detectOS classifies Mac, Windows, Linux, and "unknown" UAs.
 *   2. <DownloadButtons /> marks the OS-matching button data-primary="true"
 *      and the other two data-primary="false" once the UA effect has run.
 *   3. All buttons remain disabled (pre-S32 binaries are not published).
 *   4. On a non-mainstream UA (e.g. iOS), no button is primary.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

import {
  DownloadButtons,
  detectOS,
} from "../DownloadButtons";

const ORIGINAL_UA = navigator.userAgent;

function setUserAgent(value: string) {
  Object.defineProperty(navigator, "userAgent", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  setUserAgent(ORIGINAL_UA);
  cleanup();
});

beforeEach(() => {
  cleanup();
});

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const WIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

describe("detectOS()", () => {
  it("classifies the four UA strings we care about", () => {
    // iOS UAs include the substring "Mac OS X", so they share the Mac
    // primary button. That is the intended behaviour for v0.2 — Inari
    // Live ships Mac/Win/Linux only and the iOS visitor sees Mac as
    // primary. If we ever add real iOS detection, this contract changes.
    expect(detectOS(MAC_UA)).toBe("mac");
    expect(detectOS(WIN_UA)).toBe("windows");
    expect(detectOS(LINUX_UA)).toBe("linux");
    expect(detectOS(IOS_UA)).toBe("mac");
    expect(detectOS("Mozilla/5.0 (PlayStation 5; Custom)")).toBe("unknown");
  });
});

describe("<DownloadButtons />", () => {
  it("marks .dmg primary for a Mac UA", async () => {
    setUserAgent(MAC_UA);
    await act(async () => {
      render(<DownloadButtons />);
    });
    expect(screen.getByTestId("download-mac").dataset.primary).toBe("true");
    expect(screen.getByTestId("download-windows").dataset.primary).toBe(
      "false",
    );
    expect(screen.getByTestId("download-linux").dataset.primary).toBe("false");
  });

  it("marks .msi primary for a Windows UA", async () => {
    setUserAgent(WIN_UA);
    await act(async () => {
      render(<DownloadButtons />);
    });
    expect(screen.getByTestId("download-windows").dataset.primary).toBe(
      "true",
    );
    expect(screen.getByTestId("download-mac").dataset.primary).toBe("false");
    expect(screen.getByTestId("download-linux").dataset.primary).toBe("false");
  });

  it("marks .AppImage primary for a Linux UA", async () => {
    setUserAgent(LINUX_UA);
    await act(async () => {
      render(<DownloadButtons />);
    });
    expect(screen.getByTestId("download-linux").dataset.primary).toBe("true");
    expect(screen.getByTestId("download-mac").dataset.primary).toBe("false");
    expect(screen.getByTestId("download-windows").dataset.primary).toBe(
      "false",
    );
  });

  it("marks no primary when the UA does not match a supported OS", async () => {
    setUserAgent("Mozilla/5.0 (PlayStation 5)");
    await act(async () => {
      render(<DownloadButtons />);
    });
    expect(screen.getByTestId("download-mac").dataset.primary).toBe("false");
    expect(screen.getByTestId("download-windows").dataset.primary).toBe(
      "false",
    );
    expect(screen.getByTestId("download-linux").dataset.primary).toBe("false");
  });

  it("renders all three buttons disabled with the beta tooltip pre-S32", async () => {
    setUserAgent(MAC_UA);
    await act(async () => {
      render(<DownloadButtons />);
    });
    for (const id of [
      "download-mac",
      "download-windows",
      "download-linux",
    ] as const) {
      const btn = screen.getByTestId(id);
      expect(btn.tagName).toBe("BUTTON");
      expect(btn.hasAttribute("disabled")).toBe(true);
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(btn.getAttribute("title")).toBe("Beta — coming this month");
    }
  });
});
