/**
 * S9 — MicButton state machine tests.
 *
 * Mocks `getUserMedia` + `MediaRecorder` so the test never touches a
 * real microphone, and injects fake `transcribe` + `toWav` callables
 * via the component's escape-hatch props. The state attribute on the
 * rendered button is the assertion surface — `data-state` flips
 * idle → recording → transcribing → idle in order.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MicButton } from "../MicButton";

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners: Record<string, Array<() => void>> = {};

  constructor(public stream: MediaStream, public opts?: MediaRecorderOptions) {
    FakeMediaRecorder.instances.push(this);
  }

  start(_chunkMs?: number) {
    this.state = "recording";
    // Drop a fake chunk so the BlobBuilder gets non-zero bytes.
    this.ondataavailable?.({
      data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }),
    } as BlobEvent);
  }

  stop() {
    this.state = "inactive";
    (this.listeners["stop"] || []).forEach((fn) => fn());
  }

  addEventListener(event: string, listener: () => void) {
    this.listeners[event] = [...(this.listeners[event] || []), listener];
  }

  removeEventListener(event: string, listener: () => void) {
    this.listeners[event] = (this.listeners[event] || []).filter((fn) => fn !== listener);
  }

  static isTypeSupported(_t: string) {
    return true;
  }
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MicButton", () => {
  it("renders idle state initially", () => {
    render(
      <MicButton
        pushToTalk={false}
        onTranscribed={() => undefined}
        getUserMedia={vi.fn() as unknown as typeof navigator.mediaDevices.getUserMedia}
        transcribe={vi.fn()}
        toWav={vi.fn(async () => new ArrayBuffer(0))}
      />,
    );
    const btn = screen.getByTestId("mic-button");
    expect(btn).toHaveAttribute("data-state", "idle");
  });

  it("cycles idle → recording → transcribing → idle on click toggle", async () => {
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream) as unknown as typeof navigator.mediaDevices.getUserMedia;
    const transcribe = vi.fn(async () => ({
      text: "hello world",
      engine: "mock",
      audio_duration_ms: 1000,
    }));
    const toWav = vi.fn(async () => new ArrayBuffer(8));
    const onTranscribed = vi.fn();

    render(
      <MicButton
        pushToTalk={false}
        onTranscribed={onTranscribed}
        getUserMedia={getUserMedia}
        transcribe={transcribe}
        toWav={toWav}
      />,
    );

    const btn = screen.getByTestId("mic-button");
    expect(btn).toHaveAttribute("data-state", "idle");

    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(btn).toHaveAttribute("data-state", "recording"));

    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(onTranscribed).toHaveBeenCalledWith("hello world"));
    await waitFor(() => expect(btn).toHaveAttribute("data-state", "idle"));
  });

  it("flips to error state when getUserMedia is denied", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    }) as unknown as typeof navigator.mediaDevices.getUserMedia;
    const onError = vi.fn();

    render(
      <MicButton
        pushToTalk={false}
        onTranscribed={() => undefined}
        onError={onError}
        getUserMedia={getUserMedia}
        transcribe={vi.fn()}
        toWav={vi.fn(async () => new ArrayBuffer(0))}
      />,
    );

    const btn = screen.getByTestId("mic-button");
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(btn).toHaveAttribute("data-state", "error"));
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/Permission denied/));
  });

  it("starts recording on pointerdown when push-to-talk is on", async () => {
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream) as unknown as typeof navigator.mediaDevices.getUserMedia;
    const transcribe = vi.fn(async () => ({
      text: "ptt result",
      engine: "mock",
      audio_duration_ms: 500,
    }));
    const onTranscribed = vi.fn();

    render(
      <MicButton
        pushToTalk={true}
        onTranscribed={onTranscribed}
        getUserMedia={getUserMedia}
        transcribe={transcribe}
        toWav={vi.fn(async () => new ArrayBuffer(8))}
      />,
    );

    const btn = screen.getByTestId("mic-button");
    await act(async () => {
      fireEvent.pointerDown(btn);
    });
    await waitFor(() => expect(btn).toHaveAttribute("data-state", "recording"));
    await act(async () => {
      fireEvent.pointerUp(btn);
    });
    await waitFor(() => expect(onTranscribed).toHaveBeenCalledWith("ptt result"));
  });

  it("does not call onTranscribed when transcript is empty", async () => {
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream) as unknown as typeof navigator.mediaDevices.getUserMedia;
    const transcribe = vi.fn(async () => ({
      text: "",
      engine: "mock",
      audio_duration_ms: 0,
    }));
    const onTranscribed = vi.fn();
    const onError = vi.fn();

    render(
      <MicButton
        pushToTalk={false}
        onTranscribed={onTranscribed}
        onError={onError}
        getUserMedia={getUserMedia}
        transcribe={transcribe}
        toWav={vi.fn(async () => new ArrayBuffer(8))}
      />,
    );

    const btn = screen.getByTestId("mic-button");
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(btn).toHaveAttribute("data-state", "recording"));
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onTranscribed).not.toHaveBeenCalled();
  });
});
