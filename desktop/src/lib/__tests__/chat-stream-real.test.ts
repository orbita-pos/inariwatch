/**
 * Sesión 18 — `installChatStreamDriver` real path.
 *
 * Mocks the Tauri runtime (`__TAURI__` global + `invoke` + `listen`)
 * and asserts:
 *   1. Dispatching a chat message invokes `start_chat_stream` with
 *      the dock's messageId.
 *   2. Synthetic `daemon:event` messages tagged `chat_token_stream`
 *      flow into `useChat.appendToken` / `useChat.finishStreaming`.
 *   3. When the IPC rejects with a "command not found" error the
 *      driver falls back to the mock streamer instead of stalling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installChatStreamDriver } from "@/lib/chat-stream";
import { __resetChatStoreForTests, useChat } from "@/lib/store/chat";

type DaemonEventListener = (msg: { payload: unknown }) => void;

const invokeMock = vi.fn(async (_cmd: string, _args?: unknown) => undefined);
let capturedListener: DaemonEventListener | null = null;
const listenMock = vi.fn(async (_channel: string, fn: DaemonEventListener) => {
  capturedListener = fn;
  return () => {
    capturedListener = null;
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (channel: string, fn: DaemonEventListener) => listenMock(channel, fn),
}));

beforeEach(() => {
  __resetChatStoreForTests();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  listenMock.mockClear();
  capturedListener = null;
  // Pretend Tauri is present.
  (window as unknown as { __TAURI__: object }).__TAURI__ = {};
});

afterEach(() => {
  delete (window as unknown as { __TAURI__?: object }).__TAURI__;
});

function emitDaemonEvent(payload: unknown) {
  if (!capturedListener) {
    throw new Error("listen() never registered a daemon:event handler");
  }
  capturedListener({ payload });
}

describe("installChatStreamDriver — real path", () => {
  it("invokes start_chat_stream and routes ChatTokenStream deltas into the store", async () => {
    const unlisten = await installChatStreamDriver();

    useChat.getState().sendMessage("why is uptime down?");

    // The stream-driver enqueues an invoke synchronously when the
    // user message hits sendMessage; tick the microtask queue so
    // Vitest sees it.
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0]!;
    expect(cmd).toBe("start_chat_stream");
    expect(args).toMatchObject({
      args: expect.objectContaining({
        prompt: "why is uptime down?",
        session_id: expect.any(String),
      }),
    });

    // Find the assistant message id the driver passed.
    const messages = useChat.getState().messages;
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant).toBeDefined();
    expect(assistant.streaming).toBe(true);

    // Synthesize 3 ChatTokenStream events + a closing finish_reason.
    emitDaemonEvent({
      kind: "chat_token_stream",
      session_id: assistant.id,
      token: "Hello",
    });
    emitDaemonEvent({
      kind: "chat_token_stream",
      session_id: assistant.id,
      token: " world",
    });
    emitDaemonEvent({
      kind: "chat_token_stream",
      session_id: assistant.id,
      token: "",
      finish_reason: "stop",
    });

    const after = useChat.getState().messages.find((m) => m.id === assistant.id)!;
    expect(after.content).toBe("Hello world");
    expect(after.streaming).toBe(false);

    unlisten();
  });

  it("falls back to the mock streamer when the Tauri command is not registered", async () => {
    const notFound = new Error("command 'start_chat_stream' not found");
    invokeMock.mockRejectedValueOnce(notFound);

    const unlisten = await installChatStreamDriver();

    useChat.getState().sendMessage("ping");
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const assistant = useChat.getState().messages.find((m) => m.role === "assistant")!;

    // Mock streamer ticks on a 50ms cadence — wait long enough for at
    // least the first token to land. The full canned response runs in
    // ~3s; we just need *evidence* that the mock kicked in.
    await new Promise((r) => setTimeout(r, 200));
    const after = useChat.getState().messages.find((m) => m.id === assistant.id)!;
    expect(after.content.length).toBeGreaterThan(0);

    unlisten();
  });

  it("ignores daemon:event payloads that aren't ChatTokenStream", async () => {
    const unlisten = await installChatStreamDriver();
    useChat.getState().sendMessage("hello");
    await Promise.resolve();
    const before = useChat.getState().messages.length;

    emitDaemonEvent({ kind: "heartbeat", uptime_secs: 10 });
    emitDaemonEvent({ kind: "fs_change", repo_id: "x" });

    expect(useChat.getState().messages.length).toBe(before);
    unlisten();
  });
});
