// @vitest-environment happy-dom
/**
 * Sesión 30 — `/inari-live` landing page contract.
 *
 * Locks the three things that MUST stay stable across redesigns:
 *   1. Hero copy — headline + subheadline are LOCKED. Any future
 *      reword of these strings should be a deliberate decision logged
 *      in INARI_LIVE_DECISIONS.md.
 *   2. The page renders the three numbered sections in order
 *      (Local AI · Cryptographic receipts · Replay).
 *   3. The receipt demo links the chip to /verify (the S29 verifier).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import InariLivePage from "../page";
import { HERO_HEADLINE, HERO_SUBHEADLINE } from "../_components/Hero";

beforeEach(() => {
  cleanup();
});

describe("<InariLivePage />", () => {
  it("renders the LOCKED hero headline + subheadline verbatim", () => {
    render(<InariLivePage />);
    expect(HERO_HEADLINE).toBe(
      "Local by default. Cloud by choice. Provable always.",
    );
    expect(HERO_SUBHEADLINE).toBe(
      "The first AI dev companion that runs entirely on your machine, signs every change cryptographically, and works in any editor.",
    );
    expect(screen.getByTestId("hero-headline").textContent).toBe(
      HERO_HEADLINE,
    );
    expect(screen.getByTestId("hero-subheadline").textContent).toBe(
      HERO_SUBHEADLINE,
    );
  });

  it("renders the three demo sections (Local AI · Receipts · Replay)", () => {
    render(<InariLivePage />);
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Tab \+ Apply that work offline/);
    expect(text).toMatch(/Every AI fix has a cryptographic receipt/);
    expect(text).toMatch(/Replay against the bug — proof, not prediction/);
    // Test ids confirm the components actually mounted, not just the
    // headline text drift-matching by accident.
    expect(screen.getByTestId("local-ai-demo")).toBeTruthy();
    expect(screen.getByTestId("receipt-demo")).toBeTruthy();
    expect(screen.getByTestId("replay-section")).toBeTruthy();
  });

  it("links the receipt chip to a /verify/r/<segment> URL", () => {
    render(<InariLivePage />);
    const chip = screen.getByTestId("receipt-chip") as HTMLAnchorElement;
    expect(chip.tagName).toBe("A");
    expect(chip.getAttribute("href")).toMatch(/^\/verify\/r\/[A-Za-z0-9_-]+$/);
    expect(chip.getAttribute("target")).toBe("_blank");
    expect(chip.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders disabled download buttons during beta (pre-S32)", () => {
    render(<InariLivePage />);
    // Hero renders one DownloadButtons row; bottom CTA renders another.
    // Each surface produces three buttons (Mac/Win/Linux). Pick the
    // first occurrence per OS via `getAllBy*` and assert the disabled
    // state on every one.
    const macButtons = screen.getAllByTestId("download-mac");
    const winButtons = screen.getAllByTestId("download-windows");
    const linuxButtons = screen.getAllByTestId("download-linux");
    expect(macButtons.length).toBeGreaterThanOrEqual(1);
    expect(winButtons.length).toBeGreaterThanOrEqual(1);
    expect(linuxButtons.length).toBeGreaterThanOrEqual(1);
    for (const b of [...macButtons, ...winButtons, ...linuxButtons]) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.hasAttribute("disabled")).toBe(true);
      expect(b.getAttribute("aria-disabled")).toBe("true");
      expect(b.getAttribute("title")).toBe("Beta — coming this month");
    }
  });
});
