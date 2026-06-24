import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as ipc from "@/lib/ipc/wizard";
import { useWizard } from "../wizard";

describe("wizard store — orchestration around IPC commands", () => {
  beforeEach(() => {
    useWizard.setState((s) => ({ ...s, _unlistenProgress: () => {} }));
    useWizard.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("setPayload resets state + auto-runs detection", async () => {
    const detect = vi.spyOn(ipc, "wizardDetectClone").mockResolvedValue({
      path: "/Users/dev/code/foo",
      framework: "next",
      host: "vercel",
    });
    useWizard.getState().setPayload({
      projectId: "p1",
      projectSlug: "foo-abc",
      repoFullName: "acme/foo",
      framework: null,
      host: null,
      createdAt: "2026-05-08T00:00:00Z",
    });
    // setPayload kicks off runDetect — wait one tick for the promise.
    await Promise.resolve();
    await Promise.resolve();
    expect(detect).toHaveBeenCalledWith("acme/foo");
    expect(useWizard.getState().detection?.path).toBe("/Users/dev/code/foo");
    // Auto-advance to plan because detection found a path.
    expect(useWizard.getState().step).toBe("plan");
  });

  it("appendLog caps the tail at 200 entries and tracks fraction", () => {
    const store = useWizard.getState();
    for (let i = 0; i < 250; i++) {
      store.appendLog({
        projectId: "p1",
        stage: "install.npm",
        message: `line ${i}`,
        fraction: i / 250,
      });
    }
    const state = useWizard.getState();
    expect(state.log.length).toBe(200);
    expect(state.log[0].message).toBe("line 50"); // first 50 dropped
    expect(state.fraction).toBeCloseTo(249 / 250, 2);
  });

  it("runInstall surfaces the IPC result and advances to run-dev", async () => {
    useWizard.getState().setPayload({
      projectId: "p1",
      projectSlug: "foo-abc",
      repoFullName: "acme/foo",
      framework: null,
      host: null,
      createdAt: "2026-05-08T00:00:00Z",
    });
    // Skip the auto-detect side effect by overriding state directly.
    useWizard.setState({
      detection: { path: "/abs/path", framework: "next", host: "vercel" },
      step: "plan",
    });

    vi.spyOn(ipc, "wizardRunInstall").mockResolvedValue({
      adopted: false,
      mint_id: "tok-1",
      fingerprint: "iwk_pub_v1_aB3xY9k",
      dsn_masked: "https://iwk_pub_v1_…@host/capture/p1",
      vercel_synced: true,
      vercel_warning: null,
    });

    await useWizard.getState().runInstall();
    const state = useWizard.getState();
    expect(state.install?.fingerprint).toBe("iwk_pub_v1_aB3xY9k");
    expect(state.step).toBe("run-dev");
    expect(state.fraction).toBe(1);
  });

  it("runDevServer marks verified=true when the test event injection succeeds", async () => {
    useWizard.getState().setPayload({
      projectId: "p1",
      projectSlug: "foo-abc",
      repoFullName: "acme/foo",
      framework: null,
      host: null,
      createdAt: "2026-05-08T00:00:00Z",
    });
    useWizard.setState({
      detection: { path: "/abs/path", framework: "next", host: "vercel" },
      step: "run-dev",
    });
    vi.spyOn(ipc, "wizardRunDev").mockResolvedValue({
      pid: 12345,
      injected: true,
      note: null,
    });
    await useWizard.getState().runDevServer();
    expect(useWizard.getState().verified).toBe(true);
    expect(useWizard.getState().step).toBe("verify");
  });

  it("runDevServer leaves verified=false when injection fails (note populated)", async () => {
    useWizard.getState().setPayload({
      projectId: "p1",
      projectSlug: "foo-abc",
      repoFullName: "acme/foo",
      framework: null,
      host: null,
      createdAt: "2026-05-08T00:00:00Z",
    });
    useWizard.setState({
      detection: { path: "/abs/path", framework: "next", host: null },
      step: "run-dev",
    });
    vi.spyOn(ipc, "wizardRunDev").mockResolvedValue({
      pid: 12345,
      injected: false,
      note: "test event POST returned 503: relay timeout",
    });
    await useWizard.getState().runDevServer();
    expect(useWizard.getState().verified).toBe(false);
    expect(useWizard.getState().runDev?.note).toContain("503");
  });

  it("dismiss clears state and calls the IPC", async () => {
    const dismiss = vi.spyOn(ipc, "wizardDismiss").mockResolvedValue(undefined);
    useWizard.getState().setPayload({
      projectId: "p1",
      projectSlug: "foo-abc",
      repoFullName: "acme/foo",
      framework: null,
      host: null,
      createdAt: "2026-05-08T00:00:00Z",
    });
    await useWizard.getState().dismiss();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(useWizard.getState().payload).toBeNull();
  });

  // ── Session 4 — Tier 2 / Tier 3 transitions ───────────────────────────────

  it("runInstall routes Tier 2 hosts to host-sync (not run-dev)", async () => {
    useWizard.getState().setPayload({
      projectId: "p1",
      projectSlug: "foo-abc",
      repoFullName: "acme/foo",
      framework: null,
      host: null,
      createdAt: "2026-05-08T00:00:00Z",
    });
    useWizard.setState({
      detection: { path: "/abs/path", framework: "next", host: "railway" },
      step: "plan",
    });

    vi.spyOn(ipc, "wizardRunInstall").mockResolvedValue({
      adopted: false,
      mint_id: "tok-1",
      fingerprint: "iwk_pub_v1_aB3xY9k",
      dsn_masked: "https://iwk_pub_v1_…@host/capture/p1",
      vercel_synced: false,
      vercel_warning: null,
    });

    await useWizard.getState().runInstall();
    const state = useWizard.getState();
    expect(state.step).toBe("host-sync");
    // hostOverride is pre-seeded from detection so the host-sync UI
    // renders Tier 2 mode immediately on entry.
    expect(state.hostOverride).toBe("railway");
    expect(state.hostAcknowledged).toBe(false);
    expect(state.clipboardStatus).toBe("idle");
  });

  it("runInstall routes Tier 3 hosts (Dockerfile) to host-sync", async () => {
    useWizard.getState().setPayload({
      projectId: "p1",
      projectSlug: "foo-abc",
      repoFullName: "acme/foo",
      framework: null,
      host: null,
      createdAt: "2026-05-08T00:00:00Z",
    });
    useWizard.setState({
      detection: { path: "/abs/path", framework: "express", host: "docker" },
      step: "plan",
    });

    vi.spyOn(ipc, "wizardRunInstall").mockResolvedValue({
      adopted: false,
      mint_id: "tok-2",
      fingerprint: "iwk_pub_v1_zZ7xy3q",
      dsn_masked: "…",
      vercel_synced: false,
      vercel_warning: null,
    });

    await useWizard.getState().runInstall();
    expect(useWizard.getState().step).toBe("host-sync");
    expect(useWizard.getState().hostOverride).toBe("docker");
  });

  it("runInstall routes null-detection (universal escape) to host-sync without a host", async () => {
    useWizard.getState().setPayload({
      projectId: "p1",
      projectSlug: "foo-abc",
      repoFullName: "acme/foo",
      framework: null,
      host: null,
      createdAt: "2026-05-08T00:00:00Z",
    });
    useWizard.setState({
      detection: { path: "/abs/path", framework: "next", host: null },
      step: "plan",
    });

    vi.spyOn(ipc, "wizardRunInstall").mockResolvedValue({
      adopted: false,
      mint_id: "tok-3",
      fingerprint: "iwk_pub_v1_qQ7tt8s",
      dsn_masked: "…",
      vercel_synced: false,
      vercel_warning: null,
    });

    await useWizard.getState().runInstall();
    expect(useWizard.getState().step).toBe("host-sync");
    // No detection = no override; React renders the dropdown.
    expect(useWizard.getState().hostOverride).toBeNull();
  });

  it("runInstall sends Vercel+sync_failed users to host-sync so they can paste manually", async () => {
    useWizard.getState().setPayload({
      projectId: "p1",
      projectSlug: "foo-abc",
      repoFullName: "acme/foo",
      framework: null,
      host: null,
      createdAt: "2026-05-08T00:00:00Z",
    });
    useWizard.setState({
      detection: { path: "/abs/path", framework: "next", host: "vercel" },
      step: "plan",
    });

    vi.spyOn(ipc, "wizardRunInstall").mockResolvedValue({
      adopted: false,
      mint_id: "tok-4",
      fingerprint: "iwk_pub_v1_xY3zZ1k",
      dsn_masked: "…",
      vercel_synced: false,
      vercel_warning: "no_vercel_integration",
    });

    await useWizard.getState().runInstall();
    expect(useWizard.getState().step).toBe("host-sync");
    expect(useWizard.getState().hostOverride).toBe("vercel");
  });

  it("setHostOverride invalidates a previous I-added-it click", () => {
    useWizard.setState({
      hostOverride: "railway",
      hostAcknowledged: true,
      clipboardStatus: "copied",
    });
    useWizard.getState().setHostOverride("netlify");
    const s = useWizard.getState();
    expect(s.hostOverride).toBe("netlify");
    expect(s.hostAcknowledged).toBe(false);
    expect(s.clipboardStatus).toBe("idle");
  });

  it("acknowledgeHostSetup advances to run-dev and flips the ack flag", () => {
    useWizard.setState({ step: "host-sync", hostOverride: "fly" });
    useWizard.getState().acknowledgeHostSetup();
    const s = useWizard.getState();
    expect(s.hostAcknowledged).toBe(true);
    expect(s.step).toBe("run-dev");
  });

  it("copyTokenToClipboard surfaces success", async () => {
    useWizard.getState().setPayload({
      projectId: "p1",
      projectSlug: "foo-abc",
      repoFullName: "acme/foo",
      framework: null,
      host: null,
      createdAt: "2026-05-08T00:00:00Z",
    });
    vi.spyOn(ipc, "wizardCopyProjectTokenToClipboard").mockResolvedValue(
      "iwk_pub_v1_aB3xY9k…",
    );
    await useWizard.getState().copyTokenToClipboard();
    expect(useWizard.getState().clipboardStatus).toBe("copied");
    expect(useWizard.getState().error).toBeNull();
  });

  it("copyTokenToClipboard surfaces error", async () => {
    useWizard.getState().setPayload({
      projectId: "p1",
      projectSlug: "foo-abc",
      repoFullName: "acme/foo",
      framework: null,
      host: null,
      createdAt: "2026-05-08T00:00:00Z",
    });
    vi.spyOn(ipc, "wizardCopyProjectTokenToClipboard").mockRejectedValue(
      new Error("clipboard write failed: access denied"),
    );
    await useWizard.getState().copyTokenToClipboard();
    expect(useWizard.getState().clipboardStatus).toBe("error");
    expect(useWizard.getState().error).toContain("clipboard");
  });

  it("openHostDashboard skips Tier 3 (no deeplink) silently", async () => {
    const open = vi.spyOn(ipc, "wizardOpenHostDashboard").mockResolvedValue();
    useWizard.setState({ hostOverride: "kubernetes" });
    await useWizard.getState().openHostDashboard();
    expect(open).not.toHaveBeenCalled();
  });

  it("openHostDashboard opens a Tier 2 dashboard URL", async () => {
    const open = vi.spyOn(ipc, "wizardOpenHostDashboard").mockResolvedValue();
    useWizard.setState({ hostOverride: "railway" });
    await useWizard.getState().openHostDashboard();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toContain("railway.app");
  });
});
