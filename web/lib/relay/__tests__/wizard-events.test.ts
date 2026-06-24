import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __WIZARD_OPEN_TASK_FOR_TESTS,
  emitWizardOpen,
} from "../wizard-events";

describe("wizard event emitter — relay dispatch contract", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.RELAY_URL = "https://relay.example.test";
    process.env.RELAY_DISPATCH_SECRET = "shh";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("returns config-missing failure when RELAY_URL is unset", async () => {
    delete process.env.RELAY_URL;

    const out = await emitWizardOpen("user-A", {
      projectId: "p1",
      projectSlug: "p-1",
      repoFullName: "acme/api",
      framework: "next",
      host: "vercel",
      createdAt: "2026-05-08T00:00:00Z",
    });

    expect(out).toEqual({ ok: false, reason: "config-missing" });
  });

  it("posts to /dispatch with the canonical task name + payload", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          requestId: "rid-1",
          userId: "user-A",
          task: __WIZARD_OPEN_TASK_FOR_TESTS,
          body: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const out = await emitWizardOpen("user-A", {
      projectId: "p1",
      projectSlug: "p-1",
      repoFullName: "acme/api",
      framework: "next",
      host: "vercel",
      createdAt: "2026-05-08T00:00:00Z",
    });

    expect(out.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://relay.example.test/dispatch");
    expect((init as RequestInit | undefined)?.method).toBe("POST");
    const body = JSON.parse(((init as RequestInit | undefined)?.body as string) ?? "{}");
    expect(body.user_id).toBe("user-A");
    expect(body.task).toBe("project.wizard.open");
    expect(body.payload).toEqual({
      projectId: "p1",
      projectSlug: "p-1",
      repoFullName: "acme/api",
      framework: "next",
      host: "vercel",
      createdAt: "2026-05-08T00:00:00Z",
    });
  });

  it("surfaces a non-ok outcome when the relay rejects the dispatch", async () => {
    // dispatchToRelay's retry loop catches RelayError as a "network
    // failure" candidate, so a persistent 503 from the relay surfaces
    // as the post-retry "relay-unreachable" reason. Either way, the
    // wizard caller's UX is the same — flip the status pill to "Open
    // Inari Live" and stop. We assert on the !ok contract rather than
    // the specific reason so a future retry-loop fix to dispatchToRelay
    // (returning the inner RelayError code untouched) doesn't cause a
    // false test failure here.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "sidecar-offline" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );

    const out = await emitWizardOpen("user-A", {
      projectId: "p1",
      projectSlug: "p-1",
      repoFullName: "acme/api",
      framework: null,
      host: null,
      createdAt: "2026-05-08T00:00:00Z",
    });

    expect(out.ok).toBe(false);
    if (!out.ok) {
      // Acceptable failure reasons reflect the dispatchToRelay retry
      // semantics: either the inner RelayError code surfaced cleanly
      // ("sidecar-offline") OR the retry loop wrapped it as
      // "relay-unreachable". Both map to the same wizard UX.
      expect(["sidecar-offline", "relay-unreachable"]).toContain(out.reason);
    }
  });

  it("never throws on transport failures — surfaces relay-unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const out = await emitWizardOpen("user-A", {
      projectId: "p1",
      projectSlug: "p-1",
      repoFullName: "acme/api",
      framework: null,
      host: null,
      createdAt: "2026-05-08T00:00:00Z",
    });

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("relay-unreachable");
    }
  });
});
