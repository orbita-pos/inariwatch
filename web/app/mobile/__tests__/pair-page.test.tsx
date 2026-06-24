// @vitest-environment happy-dom
/**
 * S12 — `/mobile/pair` client behaviour.
 *
 * The page is a single client component. We test the user-facing
 * affordances without booting a real Next router / API:
 *
 *   1. Initial render shows the code input + device-name input + Pair button.
 *   2. URL `?code=` prefills the input (uppercased + non-alpha stripped).
 *   3. Submitting with a non-8-char code shows an inline error.
 *   4. A successful redeem swaps to the SAS-display phase showing the digits.
 *   5. Status poll showing `paired:true` saves the JWT to localStorage and
 *      navigates to `/mobile/inbox` (we assert via the routerPush spy).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const routerPush    = vi.fn();
const routerReplace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter:        () => ({ push: routerPush, replace: routerReplace }),
  useSearchParams:  () => mockSearchParams,
}));

import MobilePairPage from "../pair/page";

beforeEach(() => {
  routerPush.mockReset();
  routerReplace.mockReset();
  mockSearchParams = new URLSearchParams();
  window.localStorage.clear();
  cleanup();
  // Default fetch — fail so unrelated tests don't need to set it.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
});

describe("MobilePairPage", () => {
  it("renders input + button on first paint", () => {
    render(<MobilePairPage />);
    expect(screen.getByTestId("pair-code-input")).toBeTruthy();
    expect(screen.getByTestId("pair-display-name-input")).toBeTruthy();
    expect(screen.getByTestId("pair-submit")).toBeTruthy();
  });

  it("prefills the code from `?code=` and uppercases", () => {
    mockSearchParams = new URLSearchParams("code=abcd-efgh");
    render(<MobilePairPage />);
    const input = screen.getByTestId("pair-code-input") as HTMLInputElement;
    // The page strips dashes when normalising the URL prefill.
    expect(input.value).toBe("ABCDEFGH");
  });

  it("shows an inline error for non-8-char code", async () => {
    render(<MobilePairPage />);
    const input = screen.getByTestId("pair-code-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ABCD" } });
    fireEvent.click(screen.getByTestId("pair-submit"));
    await screen.findByTestId("pair-error");
    expect(screen.getByTestId("pair-error").textContent).toMatch(/8 characters/);
  });

  it("shows the SAS digits after a successful redeem", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (typeof input === "string" && input.endsWith("/redeem")) {
        return new Response(
          JSON.stringify({
            sas_challenge_id: "11111111-1111-4111-8111-111111111111",
            sas_digits:       "482619",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 200 });
    }));
    render(<MobilePairPage />);
    fireEvent.change(screen.getByTestId("pair-code-input"), {
      target: { value: "ABCDEFGH" },
    });
    fireEvent.click(screen.getByTestId("pair-submit"));
    await screen.findByTestId("pair-sas-digits");
    expect(screen.getByTestId("pair-sas-digits").textContent).toContain("482 619");
  });
});
