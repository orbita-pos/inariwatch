import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReplayButton } from "@/components/ReplayButton";
import type { ReplayResultDto } from "@/lib/dock-ipc";

describe("ReplayButton", () => {
  it("renders the no-recording CTA when hasRecording is false", () => {
    render(
      <ReplayButton sessionId="sess-1" alertId="alert-1" hasRecording={false} />,
    );
    const btn = screen.getByTestId("replay-button");
    expect(btn).toHaveAttribute("data-replay-state", "no-recording");
    expect(btn).toHaveTextContent(/no recording/i);
    expect(btn).toHaveTextContent(/generate one/i);
  });

  it("calls the IPC and renders the green-passed badge on success", async () => {
    const okResult: ReplayResultDto = {
      kind: "ok",
      throwReproduced: false,
      throwsAfter: 0,
      runnerMode: "drain-only",
      fixBranch: "deadbee",
      durationMs: 123,
      headThrow: null,
    };
    const invokeMock = vi.fn(
      async (_session: string, _alert: string) => okResult,
    );

    render(
      <ReplayButton
        sessionId="sess-1"
        alertId="alert-1"
        hasRecording={true}
        invoke={invokeMock}
      />,
    );

    const btn = screen.getByTestId("replay-button");
    expect(btn).toHaveAttribute("data-replay-state", "idle");

    act(() => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(screen.getByTestId("replay-button")).toHaveAttribute(
        "data-replay-state",
        "passed",
      );
    });

    expect(invokeMock).toHaveBeenCalledWith("sess-1", "alert-1");
    expect(screen.getByTestId("replay-button")).toHaveTextContent(
      /Fix prevented throw/i,
    );
    expect(screen.getByTestId("replay-button-duration")).toHaveTextContent(
      /123/,
    );
  });

  it("renders the diverged-red badge when the patch did not prevent the throw", async () => {
    const divergedResult: ReplayResultDto = {
      kind: "ok",
      throwReproduced: true,
      throwsAfter: 1,
      runnerMode: "drain-only",
      fixBranch: "deadbee",
      durationMs: 87,
      headThrow: {
        exceptionName: "TypeError",
        exceptionMessage: "Cannot read 'id' of undefined",
        topFrameFunction: "handler",
        topFrameFile: "src/main.ts",
        topFrameLine: 42,
      },
    };
    render(
      <ReplayButton
        sessionId="s"
        alertId="a"
        hasRecording={true}
        invoke={vi.fn(async () => divergedResult)}
      />,
    );

    fireEvent.click(screen.getByTestId("replay-button"));
    await waitFor(() => {
      expect(screen.getByTestId("replay-button")).toHaveAttribute(
        "data-replay-state",
        "diverged",
      );
    });
    expect(screen.getByTestId("replay-button")).toHaveTextContent(
      /didn't prevent throw/i,
    );
  });

  it("surfaces request_failed as a red retryable badge", async () => {
    const failed: ReplayResultDto = {
      kind: "request_failed",
      status: 503,
      error: "binary not yet rsynced",
    };
    render(
      <ReplayButton
        sessionId="s"
        alertId="a"
        hasRecording={true}
        invoke={vi.fn(async () => failed)}
      />,
    );
    fireEvent.click(screen.getByTestId("replay-button"));
    await waitFor(() => {
      expect(screen.getByTestId("replay-button")).toHaveAttribute(
        "data-replay-state",
        "failed",
      );
    });
    expect(screen.getByTestId("replay-button-error")).toHaveTextContent(
      /503/,
    );
  });
});
