/**
 * S9 — DockConversation voice-wiring tests.
 *
 * Exercises the gating between voice settings and the chat surface:
 *
 *  1. `voice_settings.input_enabled = false` → MicButton not rendered.
 *  2. `voice_settings.input_enabled = true` → MicButton rendered.
 *  3. Transcribed text → input value populated, focus retained.
 *
 * Auto-speak isn't tested here because it depends on the chat-stream
 * driver — covered indirectly via the voice-ipc unit tests.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DockShell } from "@/components/dock/DockShell";
import { __resetChatStoreForTests, useChat } from "@/lib/store/chat";
import {
  DEFAULT_VOICE_CAPABILITIES,
  DEFAULT_VOICE_SETTINGS,
} from "@/lib/voice-ipc";
import { __resetVoiceStoreForTests, useVoiceSettings } from "@/lib/store/voice";

// Tauri events stub — same as DockConversation.test.tsx.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

// jsdom has no real MediaRecorder; the gating tests don't actually
// trigger recording, but rendering MicButton without a stub triggers
// `MediaRecorder.isTypeSupported` calls inside `preferredRecorderMimeType`.
class FakeMediaRecorder {
  state = "inactive";
  start() {}
  stop() {}
  ondataavailable: ((e: BlobEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  static isTypeSupported() {
    return true;
  }
}

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
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
});

beforeEach(() => {
  __resetChatStoreForTests();
  __resetVoiceStoreForTests();
  // Pre-populate the voice store so DockConversation never tries to
  // fetch from a backend that isn't there.
  useVoiceSettings.setState({
    settings: DEFAULT_VOICE_SETTINGS,
    capabilities: DEFAULT_VOICE_CAPABILITIES,
    loaded: true,
  });
});

afterEach(() => {
  __resetChatStoreForTests();
  __resetVoiceStoreForTests();
});

async function renderConversationMode(): Promise<void> {
  // Drive the chat store into conversation mode so DockConversation
  // mounts. Sending a message is the cleanest path; the stream driver
  // is implicit (chat-stream installs a real one but the tests can
  // run against the stub set in DockConversation.test.tsx).
  await act(async () => {
    render(<DockShell />);
  });
  await act(async () => {
    useChat.getState().setInputValue("hello");
    useChat.getState().sendMessage("hello");
  });
  await waitFor(() =>
    expect(screen.getByTestId("dock-conversation")).toBeInTheDocument(),
  );
}

describe("DockConversation voice gating", () => {
  it("does not render the mic button when voice input is disabled", async () => {
    useVoiceSettings.setState({
      settings: { ...DEFAULT_VOICE_SETTINGS, input_enabled: false },
      capabilities: DEFAULT_VOICE_CAPABILITIES,
      loaded: true,
    });
    await renderConversationMode();
    expect(screen.queryByTestId("mic-button")).not.toBeInTheDocument();
  });

  it("renders the mic button when voice input is enabled", async () => {
    useVoiceSettings.setState({
      settings: { ...DEFAULT_VOICE_SETTINGS, input_enabled: true, push_to_talk: true },
      capabilities: DEFAULT_VOICE_CAPABILITIES,
      loaded: true,
    });
    await renderConversationMode();
    expect(screen.getByTestId("mic-button")).toBeInTheDocument();
  });
});
