/**
 * Tests for the Inari Live V1 Session 5 conversation slash commands.
 *
 * Each handler routes through the shared `dispatchSlashCommand` with a
 * `conversationId` set on the context. We pass an in-memory IPC stub
 * via `ctx.conversationIpc` so the tests don't require the Tauri
 * runtime — same posture as the existing slash-dispatch tests.
 */

import { describe, expect, it } from "vitest";

import {
  dispatchSlashCommand,
  type ConversationSlashIpc,
  type SlashCtx,
} from "../slash-dispatch";
import { parseSlashCommand } from "../slash";
import type { ChatMessage } from "../store/chat";

interface IpcCallLog {
  setStateCalls: Array<{ id: string; args: Parameters<ConversationSlashIpc["setState"]>[1] }>;
  verifyChainCalls: Array<string>;
}

function makeCtx(
  conversationId: string | null,
  ipcOverrides?: Partial<ConversationSlashIpc>,
): { ctx: SlashCtx; pushed: ChatMessage[]; log: IpcCallLog } {
  const pushed: ChatMessage[] = [];
  const log: IpcCallLog = { setStateCalls: [], verifyChainCalls: [] };

  const ipc: ConversationSlashIpc = {
    setState: async (id, args) => {
      log.setStateCalls.push({ id, args });
    },
    verifyChain: async (id) => {
      log.verifyChainCalls.push(id);
      return { ok: true, totalMessages: 3, firstBreakAt: null };
    },
    ...ipcOverrides,
  };

  const ctx: SlashCtx = {
    appendMessage: (m) => { pushed.push(m); },
    sessionId: "test-session",
    conversationId,
    conversationIpc: ipc,
  };
  return { ctx, pushed, log };
}

describe("conversation slash commands", () => {
  it("rejects when no conversationId is set", async () => {
    const { ctx, pushed, log } = makeCtx(null);
    const parsed = parseSlashCommand("/snooze 2h")!;
    await dispatchSlashCommand(parsed, ctx);
    // First message is the user echo, second is the rejection note.
    expect(pushed.length).toBeGreaterThanOrEqual(2);
    const note = pushed[pushed.length - 1];
    expect(note.role).toBe("assistant");
    expect(note.content).toMatch(/needs an open conversation/i);
    expect(log.setStateCalls).toHaveLength(0);
  });

  it("/snooze posts state with parsed time", async () => {
    const { ctx, pushed, log } = makeCtx("conv-1");
    const parsed = parseSlashCommand("/snooze 2h")!;
    await dispatchSlashCommand(parsed, ctx);
    expect(log.setStateCalls).toHaveLength(1);
    expect(log.setStateCalls[0].id).toBe("conv-1");
    expect(log.setStateCalls[0].args.state).toBe("snoozed");
    expect(typeof log.setStateCalls[0].args.snoozedUntil).toBe("string");
    const note = pushed[pushed.length - 1];
    expect(note.content).toMatch(/Snoozed until/i);
  });

  it("/snooze rejects bad time input without IPC call", async () => {
    const { ctx, pushed, log } = makeCtx("conv-1");
    const parsed = parseSlashCommand("/snooze zorp")!;
    await dispatchSlashCommand(parsed, ctx);
    expect(log.setStateCalls).toHaveLength(0);
    const note = pushed[pushed.length - 1];
    expect(note.content).toMatch(/snooze/i);
  });

  it("/resolve posts state without summary", async () => {
    const { ctx, pushed, log } = makeCtx("conv-1");
    const parsed = parseSlashCommand("/resolve")!;
    await dispatchSlashCommand(parsed, ctx);
    expect(log.setStateCalls).toHaveLength(1);
    expect(log.setStateCalls[0].args.state).toBe("resolved");
    expect(log.setStateCalls[0].args.resolutionSummary).toBeNull();
    const note = pushed[pushed.length - 1];
    expect(note.content).toMatch(/Resolved/i);
  });

  it("/resolve attaches summary text", async () => {
    const { ctx, log } = makeCtx("conv-1");
    const parsed = parseSlashCommand("/resolve patch shipped via PR 1234")!;
    await dispatchSlashCommand(parsed, ctx);
    expect(log.setStateCalls[0].args.resolutionSummary).toBe("patch shipped via PR 1234");
  });

  it("/reopen sets state back to active", async () => {
    const { ctx, log } = makeCtx("conv-1");
    const parsed = parseSlashCommand("/reopen")!;
    await dispatchSlashCommand(parsed, ctx);
    expect(log.setStateCalls[0].args.state).toBe("active");
  });

  it("/archive sets state to archived", async () => {
    const { ctx, log } = makeCtx("conv-1");
    const parsed = parseSlashCommand("/archive")!;
    await dispatchSlashCommand(parsed, ctx);
    expect(log.setStateCalls[0].args.state).toBe("archived");
  });

  it("/witness verify returns ok message", async () => {
    const { ctx, pushed, log } = makeCtx("conv-1");
    const parsed = parseSlashCommand("/witness verify")!;
    await dispatchSlashCommand(parsed, ctx);
    expect(log.verifyChainCalls).toEqual(["conv-1"]);
    const note = pushed[pushed.length - 1];
    expect(note.content).toMatch(/✓ verified/);
  });

  it("/witness with no subcommand defaults to verify", async () => {
    const { ctx, log } = makeCtx("conv-1");
    const parsed = parseSlashCommand("/witness")!;
    await dispatchSlashCommand(parsed, ctx);
    expect(log.verifyChainCalls).toEqual(["conv-1"]);
  });

  it("/witness verify reports tampered when chain is broken", async () => {
    const { ctx, pushed } = makeCtx("conv-1", {
      verifyChain: async () => ({
        ok: false,
        totalMessages: 5,
        firstBreakAt: { messageId: "m2-deadbeef", expected: "x", actual: "y", reason: "wrong_hash" },
      }),
    });
    const parsed = parseSlashCommand("/witness verify")!;
    await dispatchSlashCommand(parsed, ctx);
    const note = pushed[pushed.length - 1];
    expect(note.content).toMatch(/✗ tampered/);
  });

  it("/witness verify reports unverifiable for legacy missing-hash rows", async () => {
    const { ctx, pushed } = makeCtx("conv-1", {
      verifyChain: async () => ({
        ok: false,
        totalMessages: 2,
        firstBreakAt: { messageId: "m1-cafef00d", expected: "x", actual: null, reason: "missing_hash" },
      }),
    });
    const parsed = parseSlashCommand("/witness verify")!;
    await dispatchSlashCommand(parsed, ctx);
    const note = pushed[pushed.length - 1];
    expect(note.content).toMatch(/⚠ unverifiable/);
  });

  it("/witness export hints at the IPC export path", async () => {
    const { ctx, pushed } = makeCtx("conv-1");
    const parsed = parseSlashCommand("/witness export")!;
    await dispatchSlashCommand(parsed, ctx);
    const note = pushed[pushed.length - 1];
    expect(note.content).toMatch(/cloudConversationsVerifyChain/);
  });

  it("/ack /silence /escalate /summarize /export render V1.5 stubs", async () => {
    for (const cmd of ["/ack", "/silence 1h", "/escalate", "/summarize", "/export"]) {
      const { ctx, pushed } = makeCtx("conv-1");
      const parsed = parseSlashCommand(cmd)!;
      await dispatchSlashCommand(parsed, ctx);
      const note = pushed[pushed.length - 1];
      expect(note.role).toBe("assistant");
      expect(note.content.length).toBeGreaterThan(0);
    }
  });

  it("/export rejects unknown formats", async () => {
    const { ctx, pushed } = makeCtx("conv-1");
    const parsed = parseSlashCommand("/export xml")!;
    await dispatchSlashCommand(parsed, ctx);
    const note = pushed[pushed.length - 1];
    expect(note.content).toMatch(/format must be/i);
  });
});
