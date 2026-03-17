import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendTelegram, verifyTelegramBot, detectChatId } from "../telegram";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

// ── sendTelegram ────────────────────────────────────────────────────────────

describe("sendTelegram", () => {
  const config = { bot_token: "123:ABC", chat_id: "456" };

  it("sends message successfully", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await sendTelegram(config, "Hello");

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123:ABC/sendMessage",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"chat_id":"456"'),
      })
    );
  });

  it("sends with HTML parse mode and disables preview", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await sendTelegram(config, "<b>Test</b>");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.parse_mode).toBe("HTML");
    expect(body.disable_web_page_preview).toBe(true);
    expect(body.text).toBe("<b>Test</b>");
  });

  it("returns error on API failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ description: "Bad Request: chat not found" }),
    });

    const result = await sendTelegram(config, "Hello");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Bad Request: chat not found");
  });

  it("returns generic error when json parse fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("parse error")),
    });

    const result = await sendTelegram(config, "Hello");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Telegram API 500");
  });

  it("handles network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network failed"));

    const result = await sendTelegram(config, "Hello");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Network failed");
  });
});

// ── verifyTelegramBot ───────────────────────────────────────────────────────

describe("verifyTelegramBot", () => {
  it("returns bot name on valid token", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: { username: "my_kairo_bot" } }),
    });

    const result = await verifyTelegramBot("123:ABC");

    expect(result.ok).toBe(true);
    expect(result.botName).toBe("my_kairo_bot");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123:ABC/getMe"
    );
  });

  it("returns error on invalid token", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });

    const result = await verifyTelegramBot("bad-token");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Invalid bot token.");
  });

  it("handles network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("timeout"));

    const result = await verifyTelegramBot("123:ABC");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Could not reach Telegram API.");
  });
});

// ── detectChatId ────────────────────────────────────────────────────────────

describe("detectChatId", () => {
  it("detects chat id from message update", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          result: [{ message: { chat: { id: 789 } } }],
        }),
    });

    const result = await detectChatId("123:ABC");

    expect(result.chatId).toBe("789");
    expect(result.error).toBeUndefined();
  });

  it("detects chat id from my_chat_member update", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          result: [{ my_chat_member: { chat: { id: 101 } } }],
        }),
    });

    const result = await detectChatId("123:ABC");

    expect(result.chatId).toBe("101");
  });

  it("returns error when no updates found", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: [] }),
    });

    const result = await detectChatId("123:ABC");

    expect(result.chatId).toBeUndefined();
    expect(result.error).toContain("No messages found");
  });

  it("returns error on API failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });

    const result = await detectChatId("123:ABC");

    expect(result.error).toBe("Could not fetch updates from Telegram.");
  });

  it("handles network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("timeout"));

    const result = await detectChatId("123:ABC");

    expect(result.error).toBe("Could not reach Telegram API.");
  });
});
