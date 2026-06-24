// @vitest-environment happy-dom
/**
 * Inari Live V1 — Session 4. Component-level coverage for the manual
 * setup page's interactive surface:
 *
 *   1. Pre-mint state — token banner shows the "Generate" CTA and the
 *      snippet step labels are masked ("Mint a token to fill in the DSN").
 *   2. Post-mint state — the Rollbar reveal panel renders the plaintext
 *      and the snippets contain the DSN.
 *   3. Framework tabs swap snippet bodies (next ↔ vite).
 *   4. Host tabs render Tier 2/3 instructions; selecting a host fires
 *      the dropdown.
 *   5. SSE first_event flips the verification status pill.
 *   6. Soft nag respects the localStorage dismiss flag.
 *
 * Network calls are stubbed via `globalThis.fetch`; the SSE side runs
 * against a tiny `MockEventSource`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";

import { ManualSetupClient } from "../manual-setup-client";

// ── EventSource stub ────────────────────────────────────────────────────────

interface MockListener { (ev: { data?: string }): void }

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners = new Map<string, Set<MockListener>>();
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, l: MockListener) {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    set.add(l);
  }
  removeEventListener(type: string, l: MockListener) {
    this.listeners.get(type)?.delete(l);
  }
  close() { this.closed = true; }
  emit(type: string, data?: unknown) {
    this.listeners.get(type)?.forEach((l) => l({ data: data === undefined ? undefined : JSON.stringify(data) }));
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  // happy-dom doesn't ship EventSource — install our mock.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = MockEventSource;
  // Clean localStorage between runs so the soft-nag tests are
  // deterministic.
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PROPS_NEXT_VERCEL = {
  projectId:         "proj-1",
  projectSlug:       "foo-abc",
  repoFullName:      "acme/foo",
  detectedFramework: "next" as const,
  detectedHost:      "vercel" as const,
};

function renderClient(overrides: Partial<typeof PROPS_NEXT_VERCEL> = {}) {
  return render(<ManualSetupClient {...PROPS_NEXT_VERCEL} {...overrides} />);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("<ManualSetupClient />", () => {
  it("starts on the detected framework + host tabs", () => {
    renderClient();
    // Section copies render
    expect(screen.getByText("1. Install + wire the SDK")).toBeTruthy();
    expect(screen.getByText("2. Add INARIWATCH_DSN to your host")).toBeTruthy();
    expect(screen.getByText("3. Wait for first event")).toBeTruthy();

    // Active framework is Next.js
    const nextTab = screen.getByRole("tab", { name: /Next\.js/i });
    expect(nextTab.getAttribute("aria-selected")).toBe("true");

    // Active host is Vercel
    const vercelTab = screen.getByRole("tab", { name: /Vercel/i });
    expect(vercelTab.getAttribute("aria-selected")).toBe("true");
  });

  it("masks DSN snippets until a token is minted", () => {
    renderClient();
    // The instrumentation patch step renders a "Mint a token" hint
    // before the token is generated.
    const masks = screen.getAllByText(/Mint a token to fill in the DSN/);
    expect(masks.length).toBeGreaterThan(0);
  });

  it("Mint button calls /api/projects/{id}/tokens and reveals plaintext", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("/api/projects/proj-1/tokens");
      return new Response(JSON.stringify({
        id: "t-1",
        token: "iwk_pub_v1_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL",
        fingerprint: "iwk_pub_v1_abcdefg",
        dsn: "https://iwk_pub_v1_abc@app.test/capture/proj-1",
        created_at: "2026-05-08T00:00:00Z",
        scope: ["events:write"],
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;
    renderClient();
    const button = screen.getByRole("button", { name: /Generate token/i });
    await act(async () => {
      fireEvent.click(button);
    });
    // Reveal panel renders
    expect(screen.getByText(/Copy this token now/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("framework tabs swap the snippet body (next ↔ vite)", () => {
    renderClient();
    // Default Next.js renders next.config.ts as the patch target.
    expect(screen.getByText(/Edit next\.config\.ts/i)).toBeTruthy();

    // Click Vite — the snippet block updates.
    const viteTab = screen.getByRole("tab", { name: /Vite/i });
    fireEvent.click(viteTab);

    expect(screen.getByText(/Edit src\/main\.tsx/i)).toBeTruthy();
    // Vite tab is active.
    expect(viteTab.getAttribute("aria-selected")).toBe("true");
  });

  it("Tier 2 host tabs render the deeplink + instructions", () => {
    renderClient();
    // Click Railway tab.
    const railwayTab = screen.getByRole("tab", { name: /Railway/i });
    fireEvent.click(railwayTab);
    // Open dashboard link points at railway.app.
    const link = screen.getByRole("link", { name: /Open dashboard/i });
    expect(link.getAttribute("href")).toContain("railway.app");
    // Instructions block contains the env-var key.
    expect(screen.getAllByText(/INARIWATCH_DSN/).length).toBeGreaterThan(0);
  });

  it("Tier 3 host tabs render snippet-only instructions (no deeplink)", () => {
    renderClient();
    const k8sTab = screen.getByRole("tab", { name: /Kubernetes/i });
    fireEvent.click(k8sTab);
    // No "Open dashboard" link rendered for Tier 3.
    const link = screen.queryByRole("link", { name: /Open dashboard/i });
    expect(link).toBeNull();
    // Instructions show kubectl commands.
    expect(screen.getByText(/kubectl create secret/)).toBeTruthy();
  });

  it("SSE first_event flips the verification banner", async () => {
    renderClient();
    // Pending pill rendered initially.
    expect(screen.getByTestId("verify-pending")).toBeTruthy();

    // Fire the SSE event from the most-recent EventSource instance.
    const es = MockEventSource.instances[MockEventSource.instances.length - 1];
    expect(es).toBeTruthy();
    await act(async () => {
      es!.emit("first_event", { alertId: "a-1", at: "2026-05-08T00:00:01Z" });
    });

    // Success banner now visible.
    expect(screen.getByText(/First event received/)).toBeTruthy();
  });

  it("soft nag respects the localStorage dismiss flag", () => {
    window.localStorage.setItem(
      "inariwatch.manual_setup.soft_nag_dismissed",
      "1",
    );
    renderClient();
    expect(screen.queryByText(/Inari Live makes this 1-click/)).toBeNull();
  });

  it("dismissing the soft nag persists to localStorage", () => {
    renderClient();
    const btn = screen.getByText(/Don't show again/);
    fireEvent.click(btn);
    expect(
      window.localStorage.getItem(
        "inariwatch.manual_setup.soft_nag_dismissed",
      ),
    ).toBe("1");
    // Banner is gone from the DOM.
    expect(screen.queryByText(/Inari Live makes this 1-click/)).toBeNull();
  });
});
