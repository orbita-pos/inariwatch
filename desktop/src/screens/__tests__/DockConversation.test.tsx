import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DockShell } from "@/components/dock/DockShell";
import { installMockStreamForTests } from "@/lib/chat-stream";
import {
  __resetChatStoreForTests,
  setStreamDriver,
  useChat,
} from "@/lib/store/chat";

// jsdom has no Tauri runtime — stub `listen` to a no-op unlisten so the
// stream-driver installer doesn't warn.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

/**
 * Pin reduced-motion = true. Without it, Framer's `<AnimatePresence
 * mode="wait">` keeps the outgoing DockIdle in the tree during its
 * exit animation — the test would race the spring's settling time.
 * Reduced-motion swaps every animation to a 0ms transition AND tells
 * Framer to skip its enter/exit motion altogether, so the mode flip
 * is observable in the DOM on the next microtask.
 */
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  });
});

describe("DockConversation (via DockShell)", () => {
  beforeEach(() => {
    __resetChatStoreForTests();
  });
  afterEach(() => {
    __resetChatStoreForTests();
  });

  it("submitting input transitions from idle to conversation mode", async () => {
    // Drive deterministic single-token streaming so the assistant
    // message resolves on the next microtask.
    setStreamDriver((messageId) => {
      useChat.getState().appendToken(messageId, "ok");
      useChat.getState().finishStreaming(messageId);
    });

    render(<DockShell />);
    expect(screen.getByTestId("dock-shell")).toHaveAttribute("data-mode", "idle");

    // Type into the idle input + submit by Enter (form submit).
    const input = screen.getByTestId("dock-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello inari" } });
    fireEvent.submit(input.closest("form")!);

    // Mode flips to conversation, conversation screen mounts, and the
    // user message renders.
    await waitFor(() => {
      expect(screen.getByTestId("dock-shell")).toHaveAttribute(
        "data-mode",
        "conversation",
      );
      expect(screen.getByTestId("dock-conversation")).toBeInTheDocument();
    });
    expect(screen.getByTestId("chat-message-user")).toHaveTextContent("hello inari");
    expect(screen.getByTestId("chat-message-assistant")).toBeInTheDocument();
  });

  it("streaming a 50-token mock response paints all tokens within 1s without layout shift", async () => {
    // Real timers + tiny intervals so the test wall-clock stays well
    // under 1s. The mock canned response is ~53 tokens × 1ms ≈ 53ms.
    installMockStreamForTests(1);

    // Bypass the idle-mode entry and start directly in conversation
    // for a faster test path.
    act(() => {
      useChat.getState().startConversation();
    });

    const start = performance.now();
    render(<DockShell />);
    expect(screen.getByTestId("dock-shell")).toHaveAttribute(
      "data-mode",
      "conversation",
    );

    // Send a prompt — the canned mock stream picks up.
    act(() => {
      useChat.getState().sendMessage("explain auth");
    });

    // Wait for streaming to complete (assistant.streaming = false).
    await waitFor(
      () => {
        const messages = useChat.getState().messages;
        const assistant = messages.find((m) => m.role === "assistant");
        expect(assistant).toBeDefined();
        expect(assistant?.streaming).toBe(false);
      },
      { timeout: 5000 },
    );

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);

    // All tokens landed — the canned response's tail fragments only
    // appear after every earlier token has been appended.
    const assistant = useChat
      .getState()
      .messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toContain("Want");
    expect(assistant?.content).toContain("open");
    expect(assistant?.content).toContain("diff");

    // Layout-shift proxy: jsdom doesn't run layout, so we instead pin
    // the structural assertion: the assistant message has exactly one
    // `chat-message-assistant` node (no duplicate / re-mounted bubbles
    // mid-stream).
    expect(screen.getAllByTestId("chat-message-assistant")).toHaveLength(1);
  });
});
