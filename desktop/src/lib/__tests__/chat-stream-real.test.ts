/**
 * Phase 3 of the pure-slash refactor (2026-05-15) removed the cloud
 * free-chat path; Phase 4.6 deleted the `start_chat_stream` Tauri
 * command outright. The driver below used to invoke that IPC for
 * every non-slash submit and route `ChatTokenStream` deltas back onto
 * the assistant message. This test pins the inverse: under Tauri
 * runtime + Local AI disabled, the driver MUST NOT invoke the now-
 * deleted IPC (would surface as "command not found"), and the
 * assistant bubble finalizes empty so the UI doesn't spin forever.
 *
 * The mock-stream fallback (no Tauri runtime → mockStream) is exercised
 * separately so the test harness for jsdom/Vite-preview keeps working.
 *
 * The local-AI path is intentionally out of scope here — see
 * `useSettings.ai.local_chat_enabled`; an opt-in offline mode is the
 * one surviving free-chat surface and stays orthogonal to the
 * pure-slash architecture.
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
  // Drives the runtime-detection branch in `installChatStreamDriver`.
  // Default to "Tauri available" so each test starts in the
  // production-like path; the no-Tauri test below deletes the global
  // after the driver decides.
  isTauri: () => typeof window !== "undefined" && "__TAURI__" in window,
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

describe("installChatStreamDriver — post-Phase-3", () => {
  it("does NOT invoke start_chat_stream on non-slash submit (free chat removed, IPC deleted)", async () => {
    const unlisten = await installChatStreamDriver();

    // Deliberately picked to NOT match any Layer-0 intent (alerts,
    // uptime, deploys, status, help, etc.) so the request reaches the
    // streamDriver path and exercises the post-Phase-3 branch we care
    // about, instead of getting short-circuited by the deterministic
    // L0 intent router.
    useChat.getState().sendMessage("lorem ipsum dolor sit amet");
    // Microtask + a short macrotask tick so any (unwanted) async invoke
    // would have landed.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));

    // The deprecated IPC must NOT be invoked from the driver.
    const startChatStreamCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "start_chat_stream",
    );
    expect(startChatStreamCalls).toHaveLength(0);

    // The assistant bubble must finalize so the UI doesn't spin
    // forever — even though no content was produced.
    const assistant = useChat
      .getState()
      .messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.streaming).toBe(false);

    unlisten();
  });

  it("ignores daemon:event payloads that aren't chat events", async () => {
    const unlisten = await installChatStreamDriver();
    useChat.getState().sendMessage("hello");
    await Promise.resolve();
    const before = useChat.getState().messages.length;

    if (capturedListener) {
      capturedListener({ payload: { kind: "heartbeat", uptime_secs: 10 } });
      capturedListener({ payload: { kind: "fs_change", repo_id: "x" } });
    }

    expect(useChat.getState().messages.length).toBe(before);
    unlisten();
  });

  it("falls back to mockStream when Tauri runtime is absent", async () => {
    delete (window as unknown as { __TAURI__?: object }).__TAURI__;

    const unlisten = await installChatStreamDriver();
    useChat.getState().sendMessage("ping");
    await Promise.resolve();

    // Mock streamer ticks at 50ms — wait for at least the first token
    // to land so we see evidence the headless fallback kicked in.
    await new Promise((r) => setTimeout(r, 200));
    const assistant = useChat
      .getState()
      .messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.content.length).toBeGreaterThan(0);

    // And nobody tried to invoke the deprecated cloud IPC on the way.
    const startChatStreamCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "start_chat_stream",
    );
    expect(startChatStreamCalls).toHaveLength(0);

    unlisten();
  });
});
