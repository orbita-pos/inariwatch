import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GateRunning } from "@/screens/GateRunning";
import { __resetChatStoreForTests, useChat } from "@/lib/store/chat";
import { __resetGatesStoreForTests, useGates } from "@/lib/store/gates";

// Tauri event listener shim so vitest doesn't try to attach to a real
// channel — gate-events.ts probes `__TAURI__` and falls through to a
// no-op anyway, but the chat-stream listener also tries to listen.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

const requestBypassMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
vi.mock("@/lib/dock-ipc", async (orig) => {
  const actual = await orig<typeof import("@/lib/dock-ipc")>();
  return {
    ...actual,
    requestBypass: requestBypassMock,
  };
});

describe("GateRunning", () => {
  beforeEach(() => {
    requestBypassMock.mockClear();
  });
  afterEach(() => {
    __resetChatStoreForTests();
    __resetGatesStoreForTests();
  });

  it("renders three gate rows after a startRun + transitions states with each progress", () => {
    act(() => {
      useGates.getState().startRun({
        runId: "run-vit-1",
        repoId: "repo-x",
        gates: ["self_review", "substrate_simulate", "security_scan"],
      });
    });
    render(<GateRunning />);

    // Initial pending state for all 3.
    const list = screen.getByTestId("gate-list");
    expect(list).toBeInTheDocument();
    expect(screen.getByTestId("gate-row-self_review")).toHaveAttribute(
      "data-state",
      "pending",
    );
    expect(screen.getByTestId("gate-row-substrate_simulate")).toHaveAttribute(
      "data-state",
      "pending",
    );
    expect(screen.getByTestId("gate-row-security_scan")).toHaveAttribute(
      "data-state",
      "pending",
    );

    // Self-review running → passed.
    act(() => {
      useGates.getState().updateGate({
        runId: "run-vit-1",
        gate: "self_review",
        state: "running",
        latencyMs: 0,
      });
    });
    expect(screen.getByTestId("gate-row-self_review")).toHaveAttribute(
      "data-state",
      "running",
    );
    act(() => {
      useGates.getState().updateGate({
        runId: "run-vit-1",
        gate: "self_review",
        state: "passed",
        latencyMs: 1234,
      });
    });
    expect(screen.getByTestId("gate-row-self_review")).toHaveAttribute(
      "data-state",
      "passed",
    );

    // Substrate deferred (no recording).
    act(() => {
      useGates.getState().updateGate({
        runId: "run-vit-1",
        gate: "substrate_simulate",
        state: "deferred",
        reason: "no recent recording",
        latencyMs: 3,
      });
    });

    // Security scan failed.
    act(() => {
      useGates.getState().updateGate({
        runId: "run-vit-1",
        gate: "security_scan",
        state: "failed",
        reason: "HIGH: security/no-eval (line ~1): eval()",
        latencyMs: 8,
      });
    });
    expect(screen.getByTestId("gate-row-security_scan")).toHaveAttribute(
      "data-state",
      "failed",
    );

    // Completion → footer flips to blocked.
    act(() => {
      useGates.getState().completeRun({
        runId: "run-vit-1",
        allowed: false,
        blockingGates: ["security_scan"],
        totalLatencyMs: 1500,
      });
    });
    expect(screen.getByTestId("verdict-blocked")).toBeInTheDocument();
  });

  it("clicking [Push anyway] calls requestBypass with the active runId", async () => {
    act(() => {
      useGates.getState().startRun({
        runId: "run-vit-bypass",
        repoId: "repo-x",
        gates: ["self_review", "substrate_simulate", "security_scan"],
      });
      useGates.getState().completeRun({
        runId: "run-vit-bypass",
        allowed: false,
        blockingGates: ["security_scan"],
        totalLatencyMs: 800,
      });
    });
    render(<GateRunning />);

    const button = screen.getByTestId("bypass-button");
    expect(button).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(button);
    });

    expect(requestBypassMock).toHaveBeenCalledTimes(1);
    expect(requestBypassMock).toHaveBeenCalledWith(
      "run-vit-bypass",
      expect.any(String),
    );
    // Dismiss also clears + flips the chat mode back to idle.
    expect(useChat.getState().mode).toBe("idle");
    expect(useGates.getState().activeRunId).toBeNull();
  });

  it("renders the allowed verdict footer when run completes successfully", () => {
    act(() => {
      useGates.getState().startRun({
        runId: "run-vit-ok",
        repoId: "repo-x",
        gates: ["self_review", "substrate_simulate", "security_scan"],
      });
      useGates.getState().completeRun({
        runId: "run-vit-ok",
        allowed: true,
        blockingGates: [],
        totalLatencyMs: 920,
      });
    });
    render(<GateRunning />);
    expect(screen.getByTestId("verdict-allowed")).toBeInTheDocument();
  });
});
