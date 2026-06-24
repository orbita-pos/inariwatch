/**
 * Tests for the slash-command dispatcher orchestration.
 * Exercises every branch (non-slash, unknown command, bad args,
 * success, denied, requires_confirm bug-state, IPC throw) without
 * touching Tauri or React.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitHubRepoResult } from "../github-repo";
import {
  dispatchSlashCommand,
  formatEcho,
  formatError,
  formatGithubFailure,
  formatHelp,
  formatOutcome,
  formatTestOutcome,
  formatWhatsAppFailure,
  handleSlashSubmit,
  parseTestArgs,
  type SlashCtx,
} from "../slash-dispatch";
import type { ChatMessage } from "../store/chat";
import { __resetChatStoreForTests, useChat } from "../store/chat";
import type { InvokeOutcome } from "../tool-invoke-ipc";
import type { WhatsAppPaired, WhatsAppResolution } from "../whatsapp-recipient";

function makeCtx(
  invoke?: SlashCtx["invoke"],
  resolveActiveGitHubRepo?: SlashCtx["resolveActiveGitHubRepo"],
  resolveWhatsAppRecipient?: SlashCtx["resolveWhatsAppRecipient"],
): {
  ctx: SlashCtx;
  pushed: ChatMessage[];
} {
  const pushed: ChatMessage[] = [];
  const ctx: SlashCtx = {
    appendMessage: (m) => {
      pushed.push(m);
    },
    sessionId: "test-session",
    invoke,
    resolveActiveGitHubRepo,
    resolveWhatsAppRecipient,
  };
  return { ctx, pushed };
}

const githubOk = (
  owner = "orbita-pos",
  name = "inariwatch",
): GitHubRepoResult => ({
  ok: true,
  owner,
  name,
  baseUrl: `https://github.com/${owner}/${name}`,
});

const okOutcome = (summary?: string): InvokeOutcome => ({
  kind: "output",
  invocation_id: "inv-123",
  output: { value: { ok: true }, summary: summary ?? null },
  permission: "auto",
});

const deniedOutcome = (reason: string): InvokeOutcome => ({
  kind: "denied",
  tool: "desktop.open_url",
  reason,
});

const confirmOutcome = (): InvokeOutcome => ({
  kind: "requires_confirm",
  tool: "desktop.open_url",
  permission: "confirm",
});

describe("handleSlashSubmit (sync)", () => {
  it("returns false for non-slash input", () => {
    const { ctx, pushed } = makeCtx();
    expect(handleSlashSubmit("hello world", ctx)).toBe(false);
    expect(pushed).toEqual([]);
  });

  it("returns true and dispatches for slash input", () => {
    const invoke = vi.fn().mockResolvedValue(okOutcome("✓ opened"));
    const { ctx } = makeCtx(invoke);
    expect(handleSlashSubmit("/radio", ctx)).toBe(true);
  });
});

describe("dispatchSlashCommand", () => {
  beforeEach(() => {
    // Quiet console noise from any unhandled-rejection branches.
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("echoes the user's typing as a user message", async () => {
    const invoke = vi.fn().mockResolvedValue(okOutcome("✓"));
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand({ command: "radio", args: "" }, ctx);
    expect(pushed[0]?.role).toBe("user");
    expect(pushed[0]?.content).toBe("/radio");
  });

  it("echoes args verbatim when present", async () => {
    const invoke = vi.fn().mockResolvedValue(okOutcome("✓"));
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand(
      { command: "url", args: "https://example.com" },
      ctx,
    );
    expect(pushed[0]?.content).toBe("/url https://example.com");
  });

  it("appends an assistant note for unknown commands", async () => {
    const invoke = vi.fn();
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand({ command: "unknown", args: "" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(pushed).toHaveLength(2);
    expect(pushed[1]?.role).toBe("assistant");
    expect(pushed[1]?.content).toMatch(/Unknown command/i);
    expect(pushed[1]?.content).toMatch(/\/help/);
  });

  it("appends a 'did you mean' suggestion when the typo is close to a known command (Phase 4.4)", async () => {
    // `alrts` is one edit away from `alerts` — the Levenshtein walk
    // in error-help should surface it.
    const invoke = vi.fn();
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand({ command: "alrts", args: "" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(pushed[1]?.content).toMatch(/Unknown command `\/alrts`/);
    expect(pushed[1]?.content).toMatch(/Did you mean `\/alerts`\?/);
  });

  it("omits the did-you-mean line when the typo is too far from any command (Phase 4.4)", async () => {
    // `xyzzy` is well past the Levenshtein threshold for every manifest
    // entry — we should NOT surface a misleading suggestion.
    const invoke = vi.fn();
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand({ command: "xyzzy", args: "" }, ctx);
    expect(pushed[1]?.content).toMatch(/Unknown command `\/xyzzy`/);
    expect(pushed[1]?.content).not.toMatch(/Did you mean/);
  });

  it("renders /help inline without IPC call (meta-command)", async () => {
    const invoke = vi.fn();
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand({ command: "help", args: "" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    // user echo + assistant help note
    expect(pushed).toHaveLength(2);
    expect(pushed[1]?.role).toBe("assistant");
    expect(pushed[1]?.content).toMatch(/Available slash commands/i);
    // every catalog entry must appear so /help auto-stays-in-sync
    expect(pushed[1]?.content).toMatch(/\/radio/);
    expect(pushed[1]?.content).toMatch(/\/code/);
    expect(pushed[1]?.content).toMatch(/\/url/);
    expect(pushed[1]?.content).toMatch(/\/finder/);
    expect(pushed[1]?.content).toMatch(/\/docs/);
    expect(pushed[1]?.content).toMatch(/\/github/);
    expect(pushed[1]?.content).toMatch(/\/whatsapp/);
    expect(pushed[1]?.content).toMatch(/\/help/);
  });

  it("/? aliases to /help", async () => {
    const invoke = vi.fn();
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand({ command: "?", args: "" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(pushed[1]?.content).toMatch(/Available slash commands/i);
  });

  // ── /github -------------------------------------------------------

  it("/github (bare) opens repo home via desktop.open_url", async () => {
    const invoke = vi.fn().mockResolvedValue({
      kind: "output",
      invocation_id: "i1",
      output: { value: { ok: true }, summary: "Opened repo" },
      permission: "auto",
    } as InvokeOutcome);
    const resolve = vi.fn().mockResolvedValue(githubOk());
    const { ctx, pushed } = makeCtx(invoke, resolve);
    await dispatchSlashCommand({ command: "github", args: "" }, ctx);
    expect(invoke).toHaveBeenCalledWith(
      "desktop.open_url",
      { url: "https://github.com/orbita-pos/inariwatch" },
      "test-session",
    );
    expect(pushed[1]?.content).toBe("Opened repo");
  });

  it("/github prs maps to the /pulls subpath", async () => {
    const invoke = vi.fn().mockResolvedValue({
      kind: "output",
      invocation_id: "i1",
      output: { value: { ok: true }, summary: "ok" },
      permission: "auto",
    } as InvokeOutcome);
    const resolve = vi.fn().mockResolvedValue(githubOk("o", "r"));
    const { ctx } = makeCtx(invoke, resolve);
    await dispatchSlashCommand({ command: "github", args: "prs" }, ctx);
    expect(invoke).toHaveBeenCalledWith(
      "desktop.open_url",
      { url: "https://github.com/o/r/pulls" },
      "test-session",
    );
  });

  it("/github (unknown subcommand) reports the error without IPC", async () => {
    const invoke = vi.fn();
    const resolve = vi.fn();
    const { ctx, pushed } = makeCtx(invoke, resolve);
    await dispatchSlashCommand({ command: "github", args: "wat" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(pushed[1]?.content).toMatch(/Unknown.*subcommand/i);
    expect(pushed[1]?.content).toMatch(/wat/);
  });

  it("/github with no active repo surfaces the connect-repo hint", async () => {
    const invoke = vi.fn();
    const resolve = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "no-active-repo" } as GitHubRepoResult);
    const { ctx, pushed } = makeCtx(invoke, resolve);
    await dispatchSlashCommand({ command: "github", args: "" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(pushed[1]?.content).toMatch(/No active repo/i);
    expect(pushed[1]?.content).toMatch(/Settings.*Repos/);
  });

  it("/github with no origin remote surfaces the git-remote hint", async () => {
    const invoke = vi.fn();
    const resolve = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "no-origin-remote" } as GitHubRepoResult);
    const { ctx, pushed } = makeCtx(invoke, resolve);
    await dispatchSlashCommand({ command: "github", args: "" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(pushed[1]?.content).toMatch(/no `origin` remote/i);
    expect(pushed[1]?.content).toMatch(/git remote add/);
  });

  it("/github with non-github host names the host", async () => {
    const invoke = vi.fn();
    const resolve = vi.fn().mockResolvedValue({
      ok: false,
      reason: "non-github-host",
      detail: "gitlab.com",
    } as GitHubRepoResult);
    const { ctx, pushed } = makeCtx(invoke, resolve);
    await dispatchSlashCommand({ command: "github", args: "" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(pushed[1]?.content).toMatch(/gitlab\.com/);
    expect(pushed[1]?.content).toMatch(/not GitHub/i);
  });

  it("/gh aliases to /github", async () => {
    const invoke = vi.fn().mockResolvedValue({
      kind: "output",
      invocation_id: "i1",
      output: { value: { ok: true }, summary: null },
      permission: "auto",
    } as InvokeOutcome);
    const resolve = vi.fn().mockResolvedValue(githubOk("o", "r"));
    const { ctx } = makeCtx(invoke, resolve);
    await dispatchSlashCommand({ command: "gh", args: "issues" }, ctx);
    expect(invoke).toHaveBeenCalledWith(
      "desktop.open_url",
      { url: "https://github.com/o/r/issues" },
      "test-session",
    );
  });

  // ── /whatsapp ----------------------------------------------------

  const MOM: WhatsAppPaired = {
    entity_id: "e1",
    display_name: "Mom",
    phone: "+5215511112222",
    redacted: "+52 ••••2222",
  };

  it("/whatsapp dispatches comm.send_whatsapp on a unique match", async () => {
    const invoke = vi.fn().mockResolvedValue({
      kind: "output",
      invocation_id: "i1",
      output: { value: { ok: true }, summary: "Sent to Mom" },
      permission: "confirm",
    } as InvokeOutcome);
    const resolveWa = vi.fn().mockResolvedValue({
      ok: true,
      phone: MOM.phone,
      display_name: MOM.display_name,
      redacted: MOM.redacted,
    } as WhatsAppResolution);
    const { ctx, pushed } = makeCtx(invoke, undefined, resolveWa);
    await dispatchSlashCommand(
      { command: "whatsapp", args: "Mom Hola, llego tarde" },
      ctx,
    );
    expect(resolveWa).toHaveBeenCalledWith("Mom");
    expect(invoke).toHaveBeenCalledWith(
      "comm.send_whatsapp",
      { to: MOM.phone, message: "Hola, llego tarde" },
      "test-session",
    );
    expect(pushed[1]?.content).toBe("Sent to Mom");
  });

  it("/wa is an alias of /whatsapp", async () => {
    const invoke = vi.fn().mockResolvedValue({
      kind: "output",
      invocation_id: "i1",
      output: { value: { ok: true }, summary: null },
      permission: "confirm",
    } as InvokeOutcome);
    const resolveWa = vi.fn().mockResolvedValue({
      ok: true,
      phone: MOM.phone,
      display_name: MOM.display_name,
      redacted: MOM.redacted,
    } as WhatsAppResolution);
    const { ctx } = makeCtx(invoke, undefined, resolveWa);
    await dispatchSlashCommand({ command: "wa", args: "Mom hi" }, ctx);
    expect(invoke).toHaveBeenCalledWith(
      "comm.send_whatsapp",
      { to: MOM.phone, message: "hi" },
      "test-session",
    );
  });

  it("/whatsapp surfaces the parser error when args are incomplete", async () => {
    const invoke = vi.fn();
    const resolveWa = vi.fn();
    const { ctx, pushed } = makeCtx(invoke, undefined, resolveWa);
    await dispatchSlashCommand({ command: "whatsapp", args: "" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(resolveWa).not.toHaveBeenCalled();
    expect(pushed[1]?.content).toMatch(/Recipient.*required/i);
  });

  it("/whatsapp with single-token args asks for a message body", async () => {
    const invoke = vi.fn();
    const resolveWa = vi.fn();
    const { ctx, pushed } = makeCtx(invoke, undefined, resolveWa);
    await dispatchSlashCommand({ command: "whatsapp", args: "Mom" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(resolveWa).not.toHaveBeenCalled();
    expect(pushed[1]?.content).toMatch(/Message body required/i);
  });

  it("/whatsapp surfaces 'no paired WhatsApp' when none configured", async () => {
    const invoke = vi.fn();
    const resolveWa = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "none-paired" } as WhatsAppResolution);
    const { ctx, pushed } = makeCtx(invoke, undefined, resolveWa);
    await dispatchSlashCommand(
      { command: "whatsapp", args: "Mom hi" },
      ctx,
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(pushed[1]?.content).toMatch(/No WhatsApp paired/i);
    expect(pushed[1]?.content).toMatch(/Settings.*Channels/);
  });

  it("/whatsapp lists available names when not found", async () => {
    const invoke = vi.fn();
    const resolveWa = vi.fn().mockResolvedValue({
      ok: false,
      reason: "not-found",
      available: ["Mom", "Carlos M", "Equipo"],
    } as WhatsAppResolution);
    const { ctx, pushed } = makeCtx(invoke, undefined, resolveWa);
    await dispatchSlashCommand(
      { command: "whatsapp", args: "Frank hi" },
      ctx,
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(pushed[1]?.content).toMatch(/No paired WhatsApp matches/i);
    expect(pushed[1]?.content).toMatch(/Mom/);
    expect(pushed[1]?.content).toMatch(/Carlos M/);
    expect(pushed[1]?.content).toMatch(/raw E\.164/);
  });

  it("/whatsapp lists candidates when ambiguous", async () => {
    const invoke = vi.fn();
    const resolveWa = vi.fn().mockResolvedValue({
      ok: false,
      reason: "ambiguous",
      candidates: [
        { entity_id: "e1", display_name: "Carlos M", phone: "+1", redacted: "+1 ••••6666" },
        { entity_id: "e2", display_name: "Carlos R", phone: "+2", redacted: "+1 ••••8888" },
      ],
    } as WhatsAppResolution);
    const { ctx, pushed } = makeCtx(invoke, undefined, resolveWa);
    await dispatchSlashCommand(
      { command: "whatsapp", args: "Carlos hi" },
      ctx,
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(pushed[1]?.content).toMatch(/Multiple WhatsApp matches/i);
    expect(pushed[1]?.content).toMatch(/Carlos M/);
    expect(pushed[1]?.content).toMatch(/Carlos R/);
  });

  it("appends an assistant note for bad args", async () => {
    const invoke = vi.fn();
    const { ctx, pushed } = makeCtx(invoke);
    // /url with empty args → catalog returns error.
    await dispatchSlashCommand({ command: "url", args: "" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(pushed[1]?.content).toMatch(/URL required/i);
  });

  it("dispatches IPC with parsed args + session id and renders summary", async () => {
    const invoke = vi.fn().mockResolvedValue(okOutcome("✓ opened YouTube"));
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand({ command: "radio", args: "" }, ctx);
    expect(invoke).toHaveBeenCalledWith(
      "desktop.open_url",
      expect.objectContaining({ url: expect.stringMatching(/youtube/i) }),
      "test-session",
    );
    expect(pushed[1]?.content).toBe("✓ opened YouTube");
  });

  it("falls back to a generic 'Done' note when IPC summary is null", async () => {
    const invoke = vi.fn().mockResolvedValue(okOutcome(undefined));
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand({ command: "radio", args: "" }, ctx);
    expect(pushed[1]?.content).toMatch(/Done/);
    expect(pushed[1]?.content).toMatch(/desktop\.open_url/);
  });

  it("renders the backend's denied reason verbatim", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue(deniedOutcome("Tool is set to Deny in Settings — flip to allow."));
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand({ command: "url", args: "https://example.com" }, ctx);
    expect(pushed[1]?.content).toBe(
      "Tool is set to Deny in Settings — flip to allow.",
    );
  });

  it("flags requires_confirm as a bug (slash should bypass Confirm)", async () => {
    const invoke = vi.fn().mockResolvedValue(confirmOutcome());
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand({ command: "radio", args: "" }, ctx);
    expect(pushed[1]?.content).toMatch(/bug/i);
    expect(pushed[1]?.content).toMatch(/requires_confirm/);
  });

  it("renders IPC throws as an error note", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("network down"));
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand({ command: "radio", args: "" }, ctx);
    expect(pushed[1]?.content).toMatch(/failed/i);
    expect(pushed[1]?.content).toMatch(/network down/);
  });

  it("renders Tauri-style object errors without [object Object]", async () => {
    // Tauri IPC throws plain objects, not Error instances. The naive
    // `String(err)` on these returns "[object Object]" — the formatter
    // walks .message so the chat surfaces the real reason.
    const invoke = vi
      .fn()
      .mockRejectedValue({ message: "Path `/exce` not found." });
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand({ command: "finder", args: "/exce" }, ctx);
    expect(pushed[1]?.content).not.toMatch(/\[object Object\]/);
    expect(pushed[1]?.content).toMatch(/not found/i);
  });

  it("never throws — all errors surface as chat messages", async () => {
    const invoke = vi.fn().mockRejectedValue("string error");
    const { ctx } = makeCtx(invoke);
    await expect(
      dispatchSlashCommand({ command: "radio", args: "" }, ctx),
    ).resolves.toBeUndefined();
  });
});

describe("formatError", () => {
  it("extracts .message from Error instances", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  it("returns strings as-is", () => {
    expect(formatError("plain string")).toBe("plain string");
  });

  it("walks .message on Tauri-style error objects", () => {
    expect(formatError({ message: "ipc error", details: 42 })).toBe("ipc error");
  });

  it("walks .error as a fallback shape", () => {
    expect(formatError({ error: "another shape" })).toBe("another shape");
  });

  it("JSON-stringifies opaque objects", () => {
    expect(formatError({ kind: "weird", code: 7 })).toBe('{"kind":"weird","code":7}');
  });

  it("never returns [object Object]", () => {
    const cases: unknown[] = [
      new Error("e"),
      "s",
      { message: "m" },
      { error: "e" },
      { kind: "x" },
      null,
      undefined,
      42,
    ];
    for (const c of cases) {
      expect(formatError(c)).not.toMatch(/\[object Object\]/);
    }
  });
});

describe("formatEcho", () => {
  it("formats command without args", () => {
    expect(formatEcho({ command: "radio", args: "" })).toBe("/radio");
  });

  it("formats command with args", () => {
    expect(formatEcho({ command: "url", args: "https://example.com" })).toBe(
      "/url https://example.com",
    );
  });
});

describe("formatHelp", () => {
  it("renders every manifest entry plus the Confirm/Deny footer when no filter is supplied", () => {
    const text = formatHelp();
    expect(text).toMatch(/Available slash commands/i);
    expect(text).toMatch(/\/radio/);
    expect(text).toMatch(/\/code/);
    expect(text).toMatch(/\/url/);
    expect(text).toMatch(/\/finder/);
    expect(text).toMatch(/\/docs/);
    expect(text).toMatch(/\/github/);
    expect(text).toMatch(/\/whatsapp/);
    expect(text).toMatch(/\/help/);
    // Manifest-only entries land in the list too (Phase 4.2 switched
    // the data source from SLASH_DISPLAY to SLASH_MANIFEST).
    expect(text).toMatch(/\/projects/);
    expect(text).toMatch(/\/alerts/);
    expect(text).toMatch(/\/install/);
    expect(text).toMatch(/Confirm/i);
    expect(text).toMatch(/Deny/i);
    // The detail-hint footer should appear so users know how to drill in.
    expect(text).toMatch(/Type `\/help <name>`/);
  });

  it("treats an empty or whitespace filter the same as no filter", () => {
    expect(formatHelp("   ")).toBe(formatHelp());
    expect(formatHelp("")).toBe(formatHelp());
  });

  it("with an exact-name filter renders a detail view for that command", () => {
    const text = formatHelp("projects");
    // Detail block has the command name + its description on the
    // header line.
    expect(text).toMatch(/\*\*\/projects\*\*/);
    expect(text).toMatch(/List projects/i);
    // Arg table surfaces the integration enum values.
    expect(text).toMatch(/Arguments/);
    expect(text).toMatch(/--integration=/);
    expect(text).toMatch(/capture/);
    expect(text).toMatch(/vercel/);
    expect(text).toMatch(/github/);
    // Examples block shows the manifest examples.
    expect(text).toMatch(/Examples/);
    expect(text).toMatch(/--integration=capture/);
    // Footer back-link.
    expect(text).toMatch(/Type `\/help` for the full command list/);
    // Full-list scaffolding should NOT appear in the detail view.
    expect(text).not.toMatch(/Available slash commands/i);
  });

  it("strips a leading slash from the filter (/help /projects works)", () => {
    expect(formatHelp("/projects")).toBe(formatHelp("projects"));
  });

  it("is case-insensitive on the filter", () => {
    expect(formatHelp("Projects")).toBe(formatHelp("projects"));
  });

  it("with a substring filter that narrows to one command, renders the detail view", () => {
    // `oncal` substring-matches /oncall and (transitively in description)
    // nothing else — should land in the detail-view branch.
    const text = formatHelp("oncal");
    expect(text).toMatch(/\*\*\/oncall\*\*/);
    expect(text).toMatch(/Examples/);
  });

  it("with a substring filter that matches many commands, renders the filtered list", () => {
    // `re` exact-matches no command name, but name-substring-matches
    // /resolve + /reopen and description-substring-matches several
    // more (e.g. /alerts, /alert, /resolve, /reopen, /archive,
    // /summarize, /github, /witness). The filtered-list branch wins.
    const text = formatHelp("re");
    expect(text).toMatch(/Commands matching `re`/);
    expect(text).toMatch(/\/resolve/);
    expect(text).toMatch(/\/reopen/);
    // Detail-view scaffolding should NOT appear when many entries match.
    expect(text).not.toMatch(/\*\*Arguments:\*\*/);
  });

  it("with no matches, falls back to a no-match hint pointing at /help", () => {
    const text = formatHelp("zzzzunlikely");
    expect(text).toMatch(/No commands match `zzzzunlikely`/);
    expect(text).toMatch(/Type `\/help`/);
  });

  it("renders the optional-arg vs required-arg distinction in the detail view", () => {
    // /install has a single required positional path arg.
    const text = formatHelp("install");
    expect(text).toMatch(/\*\*\/install\*\*/);
    expect(text).toMatch(/required/);
  });

  it("commands with no args render the 'No arguments.' line in detail view", () => {
    const text = formatHelp("digest");
    expect(text).toMatch(/\*\*\/digest\*\*/);
    expect(text).toMatch(/No arguments/);
  });
});

describe("dispatchSlashCommand — /help argument flow (Phase 4.2)", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("/help projects renders the detail view, not the full list", async () => {
    const invoke = vi.fn();
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand({ command: "help", args: "projects" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(pushed).toHaveLength(2);
    expect(pushed[1]?.content).toMatch(/\*\*\/projects\*\*/);
    expect(pushed[1]?.content).toMatch(/Examples/);
    // The full-list header must be absent.
    expect(pushed[1]?.content).not.toMatch(/Available slash commands/);
  });

  it("/? projects works the same as /help projects (alias parity)", async () => {
    const invoke = vi.fn();
    const { ctx, pushed } = makeCtx(invoke);
    await dispatchSlashCommand({ command: "?", args: "projects" }, ctx);
    expect(pushed[1]?.content).toMatch(/\*\*\/projects\*\*/);
  });
});

describe("dispatchSlashCommand — /clear confirmation flow (Phase 4.3)", () => {
  beforeEach(() => {
    __resetChatStoreForTests();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    __resetChatStoreForTests();
    vi.restoreAllMocks();
  });

  function seedMessages(count: number): void {
    // Use the store's appendMessage path so the messages array is
    // shaped correctly (not just shoved in via setState).
    const append = useChat.getState().appendMessage;
    for (let i = 0; i < count; i++) {
      append({
        id: `seed_${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg ${i}`,
        createdAt: Date.now(),
      });
    }
  }

  it("/clear on an empty thread no-ops with a friendly hint", async () => {
    const { ctx, pushed } = makeCtx();
    await dispatchSlashCommand({ command: "clear", args: "" }, ctx);
    // User echo is always pushed; then the "already empty" note.
    expect(pushed).toHaveLength(2);
    expect(pushed[1]?.content).toMatch(/already empty/i);
    // Confirm the store was not touched.
    expect(useChat.getState().messages).toHaveLength(0);
  });

  it("/clear on a populated thread asks for confirmation (does NOT clear)", async () => {
    seedMessages(3);
    const { ctx, pushed } = makeCtx();
    await dispatchSlashCommand({ command: "clear", args: "" }, ctx);
    expect(pushed[1]?.content).toMatch(/clear 3 messages/i);
    expect(pushed[1]?.content).toMatch(/`\/clear yes`/);
    // Messages are still there.
    expect(useChat.getState().messages).toHaveLength(3);
  });

  it("singular when there's exactly one message in the thread", async () => {
    seedMessages(1);
    const { ctx, pushed } = makeCtx();
    await dispatchSlashCommand({ command: "clear", args: "" }, ctx);
    expect(pushed[1]?.content).toMatch(/clear 1 message\b/);
    // No trailing `s` (English-pluralization regression guard).
    expect(pushed[1]?.content).not.toMatch(/clear 1 messages/);
  });

  it("/clear yes wipes the thread + confirms", async () => {
    seedMessages(5);
    const { ctx, pushed } = makeCtx();
    await dispatchSlashCommand({ command: "clear", args: "yes" }, ctx);
    expect(useChat.getState().messages).toHaveLength(0);
    // Final assistant note pushed AFTER the store was wiped.
    expect(pushed[1]?.content).toMatch(/Conversation cleared/i);
  });

  it("accepts `/clear confirm` and `/clear --confirm` and `/clear y` as confirmation tokens", async () => {
    for (const token of ["confirm", "--confirm", "y"]) {
      __resetChatStoreForTests();
      seedMessages(2);
      const { ctx, pushed } = makeCtx();
      await dispatchSlashCommand({ command: "clear", args: token }, ctx);
      expect(useChat.getState().messages).toHaveLength(0);
      expect(pushed[1]?.content).toMatch(/Conversation cleared/i);
    }
  });

  it("rejects unknown args (e.g. /clear maybe) with the confirmation hint", async () => {
    seedMessages(2);
    const { ctx, pushed } = makeCtx();
    await dispatchSlashCommand({ command: "clear", args: "maybe" }, ctx);
    expect(useChat.getState().messages).toHaveLength(2);
    expect(pushed[1]?.content).toMatch(/`\/clear yes`/);
  });

  it("confirm token is case-insensitive", async () => {
    seedMessages(2);
    const { ctx, pushed } = makeCtx();
    await dispatchSlashCommand({ command: "clear", args: "YES" }, ctx);
    expect(useChat.getState().messages).toHaveLength(0);
    expect(pushed[1]?.content).toMatch(/Conversation cleared/i);
  });
});

describe("formatGithubFailure", () => {
  it("formats no-active-repo with a connect-repo hint", () => {
    const msg = formatGithubFailure({ ok: false, reason: "no-active-repo" });
    expect(msg).toMatch(/No active repo/i);
    expect(msg).toMatch(/Settings.*Repos/);
  });

  it("formats no-origin-remote with a git remote hint", () => {
    const msg = formatGithubFailure({ ok: false, reason: "no-origin-remote" });
    expect(msg).toMatch(/no `origin` remote/i);
    expect(msg).toMatch(/git remote add/);
  });

  it("names the non-github host when known", () => {
    const msg = formatGithubFailure({
      ok: false,
      reason: "non-github-host",
      detail: "gitlab.example.com",
    });
    expect(msg).toMatch(/gitlab\.example\.com/);
    expect(msg).toMatch(/not GitHub/i);
  });

  it("falls back gracefully when host detection failed", () => {
    const msg = formatGithubFailure({ ok: false, reason: "non-github-host" });
    expect(msg).toMatch(/non-github host/);
    expect(msg).toMatch(/Use `\/url/);
  });
});

describe("formatWhatsAppFailure", () => {
  it("formats none-paired with a Settings hint", () => {
    const msg = formatWhatsAppFailure({ ok: false, reason: "none-paired" });
    expect(msg).toMatch(/No WhatsApp paired/i);
    expect(msg).toMatch(/Settings.*Channels/);
  });

  it("lists up to 5 available names on not-found", () => {
    const available = ["A", "B", "C", "D", "E", "F", "G"];
    const msg = formatWhatsAppFailure({ ok: false, reason: "not-found", available });
    expect(msg).toMatch(/`A`/);
    expect(msg).toMatch(/`E`/);
    expect(msg).toMatch(/\+2 more/); // 7 total - 5 shown = 2 more
    expect(msg).not.toMatch(/`G`/); // truncated
  });

  it("not-found with no available names skips the listing", () => {
    const msg = formatWhatsAppFailure({
      ok: false,
      reason: "not-found",
      available: [],
    });
    // Mentions raw E.164 fallback even when there's no list to show.
    expect(msg).toMatch(/raw E\.164/);
  });

  it("not-found suggests raw E.164 as a fallback", () => {
    const msg = formatWhatsAppFailure({
      ok: false,
      reason: "not-found",
      available: ["Mom"],
    });
    expect(msg).toMatch(/\+5215512345678/);
  });

  it("lists candidates with redacted phone tails on ambiguous", () => {
    const msg = formatWhatsAppFailure({
      ok: false,
      reason: "ambiguous",
      candidates: [
        { entity_id: "1", display_name: "Carlos M", phone: "+1", redacted: "+1 ••••6666" },
        { entity_id: "2", display_name: "Carlos R", phone: "+2", redacted: "+1 ••••8888" },
      ],
    });
    expect(msg).toMatch(/Carlos M/);
    expect(msg).toMatch(/6666/);
    expect(msg).toMatch(/Carlos R/);
    expect(msg).toMatch(/8888/);
  });
});

describe("parseTestArgs (Inari Guard /test)", () => {
  it("rejects empty path", () => {
    const r = parseTestArgs("");
    expect("error" in r ? r.error : null).toMatch(/Path required/);
  });

  it("rejects whitespace-only path", () => {
    const r = parseTestArgs("   ");
    expect("error" in r ? r.error : null).toMatch(/Path required/);
  });

  it("rejects absolute paths (leading /)", () => {
    const r = parseTestArgs("/etc/passwd");
    expect("error" in r ? r.error : null).toMatch(/repo root/);
  });

  it("rejects Windows-style absolute paths (leading \\)", () => {
    const r = parseTestArgs("\\Windows\\System32\\cmd");
    expect("error" in r ? r.error : null).toMatch(/repo root/);
  });

  it("rejects path traversal (..)", () => {
    const r = parseTestArgs("src/../../secrets.ts");
    expect("error" in r ? r.error : null).toMatch(/\.\./);
  });

  it("accepts a normal repo-relative path", () => {
    const r = parseTestArgs("src/lib/auth.ts");
    expect("path" in r ? r.path : null).toBe("src/lib/auth.ts");
  });

  it("trims surrounding whitespace", () => {
    const r = parseTestArgs("   src/lib/auth.ts  ");
    expect("path" in r ? r.path : null).toBe("src/lib/auth.ts");
  });
});

describe("formatTestOutcome (Inari Guard /test)", () => {
  const baseResult = {
    sessionId: "abcd1234-5678",
    costCents: 12,
    durationMs: 31500,
  };

  it("renders a ready result with cost + duration + code block", () => {
    const out = formatTestOutcome({
      ...baseResult,
      status: "ready",
      testFile: { path: "src/lib/auth.test.ts", content: "test('x', () => {})" },
    });
    expect(out).toContain("✓ Test ready");
    expect(out).toContain("src/lib/auth.test.ts");
    expect(out).toContain("$0.120");
    expect(out).toContain("31.5s");
    expect(out).toContain("```typescript");
    expect(out).toContain("test('x'");
    expect(out).toContain("inariwatch://tests/abcd1234-5678");
  });

  it("includes PR link when prUrl is set", () => {
    const out = formatTestOutcome({
      ...baseResult,
      status: "delivered",
      testFile: { path: "src/lib/auth.test.ts", content: "test('x', () => {})" },
      prUrl: "https://github.com/orbita-pos/inariwatch/pull/123",
      prNumber: 123,
    });
    expect(out).toContain("PR opened");
    expect(out).toContain("pull/123");
  });

  it("renders a failed result with the error message", () => {
    const out = formatTestOutcome({
      ...baseResult,
      status: "failed",
      error: "Reviewer rejected fix after 2 attempts",
    });
    expect(out).toContain("✗ Generation failed");
    expect(out).toContain("Reviewer rejected");
    expect(out).toContain("$0.120");
  });

  it("truncates very long test file content", () => {
    const huge = "a".repeat(5000);
    const out = formatTestOutcome({
      ...baseResult,
      status: "ready",
      testFile: { path: "x.ts", content: huge },
    });
    expect(out).toContain("truncated");
    // Should NOT contain the full 5000-char body in the rendered string
    expect(out.length).toBeLessThan(5000 + 1000);
  });
});

describe("formatOutcome", () => {
  it("uses the IPC summary on success", () => {
    expect(
      formatOutcome("radio", "desktop.open_url", okOutcome("✓ done")),
    ).toBe("✓ done");
  });

  it("falls back to a generic 'Done' on null summary", () => {
    expect(
      formatOutcome("radio", "desktop.open_url", okOutcome(undefined)),
    ).toMatch(/Done/);
  });

  it("returns the denied reason verbatim", () => {
    expect(formatOutcome("url", "desktop.open_url", deniedOutcome("nope"))).toBe(
      "nope",
    );
  });

  it("flags requires_confirm as a bug", () => {
    expect(
      formatOutcome("radio", "desktop.open_url", confirmOutcome()),
    ).toMatch(/bug/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 5.5 — /whatsapp suspend-aware behaviour
// ───────────────────────────────────────────────────────────────────────────

describe("/whatsapp — Phase 5.5 SuspendedCommand integration", () => {
  function makeCtxWithSuspend(
    resolveWhatsAppRecipient?: SlashCtx["resolveWhatsAppRecipient"],
  ): {
    ctx: SlashCtx;
    pushed: ChatMessage[];
    suspended: Array<{
      needs: { kind: string; name: string };
      partial: { command: string; collectedArgs: Record<string, unknown>; rawArgs: string };
      rebuilt: string;
    }>;
  } {
    const pushed: ChatMessage[] = [];
    const suspended: Array<{
      needs: { kind: string; name: string };
      partial: { command: string; collectedArgs: Record<string, unknown>; rawArgs: string };
      rebuilt: string;
    }> = [];
    const ctx: SlashCtx = {
      appendMessage: (m) => pushed.push(m),
      sessionId: null,
      resolveWhatsAppRecipient,
      onSuspended: (state) => {
        // Capture rebuild output for a sample resume to lock the
        // serialisation contract.
        suspended.push({
          needs: { kind: state.needs.kind, name: state.needs.name },
          partial: state.partial,
          rebuilt: state.rebuild({
            recipient: state.partial.collectedArgs.recipient ?? "+0",
            message: "hi",
          }),
        });
      },
    };
    return { ctx, pushed, suspended };
  }

  it("suspends with contact slot when /whatsapp is invoked with no args", async () => {
    const { ctx, suspended } = makeCtxWithSuspend();
    await dispatchSlashCommand({ command: "whatsapp", args: "" }, ctx);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]!.needs.kind).toBe("contact");
    expect(suspended[0]!.needs.name).toBe("recipient");
    expect(suspended[0]!.partial.collectedArgs).toEqual({});
  });

  it("resolves the recipient and suspends with text slot when body is missing", async () => {
    const resolve = vi.fn(
      async (_q: string): Promise<WhatsAppResolution> => ({
        ok: true,
        phone: "+5215512345678",
        display_name: "Jose",
        redacted: "+52 ••••5678",
      }),
    );
    const { ctx, suspended } = makeCtxWithSuspend(resolve);
    await dispatchSlashCommand({ command: "whatsapp", args: "Jose" }, ctx);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]!.needs.kind).toBe("text");
    expect(suspended[0]!.needs.name).toBe("message");
    expect(suspended[0]!.partial.collectedArgs.recipient).toBe("+5215512345678");
    expect(suspended[0]!.partial.collectedArgs.recipient_display).toBe("Jose");
    expect(resolve).toHaveBeenCalledWith("Jose");
  });

  it("suspends with contact slot when the recipient name doesn't resolve", async () => {
    const paired: WhatsAppPaired = {
      entity_id: "e-1",
      display_name: "Mom",
      phone: "+1",
      redacted: "+1 ••••",
    };
    const resolve = vi.fn(
      async (_q: string): Promise<WhatsAppResolution> => ({
        ok: false,
        reason: "not-found",
        available: [paired.display_name],
      }),
    );
    const { ctx, suspended, pushed } = makeCtxWithSuspend(resolve);
    await dispatchSlashCommand(
      { command: "whatsapp", args: "Bogus hello" },
      ctx,
    );
    // No error note pushed — the picker handles the recovery.
    expect(pushed.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]!.needs.kind).toBe("contact");
  });

  it("suspends with contact slot when the paired list is empty", async () => {
    const resolve = vi.fn(
      async (_q: string): Promise<WhatsAppResolution> => ({
        ok: false,
        reason: "none-paired",
      }),
    );
    const { ctx, suspended } = makeCtxWithSuspend(resolve);
    await dispatchSlashCommand({ command: "whatsapp", args: "" }, ctx);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]!.needs.kind).toBe("contact");
  });

  it("happy path (both args present + recipient resolves) still dispatches the IPC", async () => {
    const resolve = vi.fn(
      async (): Promise<WhatsAppResolution> => ({
        ok: true,
        phone: "+5215512345678",
        display_name: "Jose",
        redacted: "+52 ••••5678",
      }),
    );
    const invokeMock = vi.fn(async () => okOutcome("Sent"));
    const { ctx, pushed, suspended } = makeCtxWithSuspend(resolve);
    ctx.invoke = invokeMock;
    await dispatchSlashCommand(
      { command: "whatsapp", args: "Jose hello" },
      ctx,
    );
    expect(suspended).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith(
      "comm.send_whatsapp",
      { to: "+5215512345678", message: "hello" },
      null,
    );
    // Echo + outcome note.
    expect(pushed.length).toBeGreaterThanOrEqual(2);
  });

  it("legacy path (no onSuspended) still surfaces the not-found error note", async () => {
    const resolve = vi.fn(
      async (): Promise<WhatsAppResolution> => ({
        ok: false,
        reason: "not-found",
        available: ["Mom"],
      }),
    );
    const { ctx, pushed } = makeCtx(undefined, undefined, resolve);
    // Headless caller — no onSuspended set; legacy error-note path
    // must still fire.
    await dispatchSlashCommand(
      { command: "whatsapp", args: "Bogus hello" },
      ctx,
    );
    const note = pushed.find((m) => m.role === "assistant");
    expect(note?.content).toMatch(/No paired WhatsApp matches/i);
  });

  it("rebuild serialises recipient + message as positional args", async () => {
    const resolve = vi.fn(
      async (): Promise<WhatsAppResolution> => ({
        ok: true,
        phone: "+5215512345678",
        display_name: "Jose",
        redacted: "+52 ••••5678",
      }),
    );
    const { ctx, suspended } = makeCtxWithSuspend(resolve);
    await dispatchSlashCommand({ command: "whatsapp", args: "Jose" }, ctx);
    expect(suspended[0]!.rebuilt).toBe("/whatsapp +5215512345678 hi");
  });

  it("rebuild flattens multi-line messages to a single line", async () => {
    const { whatsappRebuild } = await import("../slash-dispatch");
    const out = whatsappRebuild({
      recipient: "+1",
      message: "line one\nline two\n  line three",
    });
    expect(out).toBe("/whatsapp +1 line one line two line three");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 5.6 — /install suspend interception
// ───────────────────────────────────────────────────────────────────────────

describe("/install — Phase 5.6 SuspendedCommand integration", () => {
  function makeInstallCtx(): {
    ctx: SlashCtx;
    pushed: ChatMessage[];
    suspended: Array<{
      needs: { kind: string; name: string };
      partial: { command: string; collectedArgs: Record<string, unknown>; rawArgs: string };
      rebuilt: string;
    }>;
    invokeMock: ReturnType<typeof vi.fn>;
  } {
    const pushed: ChatMessage[] = [];
    const suspended: Array<{
      needs: { kind: string; name: string };
      partial: { command: string; collectedArgs: Record<string, unknown>; rawArgs: string };
      rebuilt: string;
    }> = [];
    const invokeMock = vi.fn(async () => okOutcome("Installed"));
    const ctx: SlashCtx = {
      appendMessage: (m) => pushed.push(m),
      sessionId: null,
      invoke: invokeMock,
      onSuspended: (state) => {
        suspended.push({
          needs: { kind: state.needs.kind, name: state.needs.name },
          partial: state.partial,
          rebuilt: state.rebuild({
            ...state.partial.collectedArgs,
            path: "D:\\web",
          }),
        });
      },
    };
    return { ctx, pushed, suspended, invokeMock };
  }

  it("suspends with path slot when /install has no args", async () => {
    const { ctx, suspended, invokeMock } = makeInstallCtx();
    await dispatchSlashCommand({ command: "install", args: "" }, ctx);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]!.needs.kind).toBe("path");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("suspends with path slot when the typed path is non-absolute", async () => {
    const { ctx, suspended } = makeInstallCtx();
    await dispatchSlashCommand({ command: "install", args: "C:web" }, ctx);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]!.needs.kind).toBe("path");
  });

  it("preserves --project=<id> flag through the suspend → resume cycle", async () => {
    const { ctx, suspended } = makeInstallCtx();
    await dispatchSlashCommand(
      { command: "install", args: "--project=abc123" },
      ctx,
    );
    expect(suspended).toHaveLength(1);
    expect(suspended[0]!.partial.collectedArgs.project_id).toBe("abc123");
    // Rebuild includes both the freshly-picked path AND the flag.
    expect(suspended[0]!.rebuilt).toBe("/install D:\\web --project=abc123");
  });

  it("happy path (absolute Windows path) dispatches the IPC without suspending", async () => {
    const { ctx, suspended, invokeMock } = makeInstallCtx();
    await dispatchSlashCommand(
      { command: "install", args: "D:\\projects\\my-app" },
      ctx,
    );
    expect(suspended).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith(
      "setup.install_capture",
      { repo_path: "D:\\projects\\my-app" },
      null,
    );
  });

  it("happy path (POSIX absolute path) dispatches the IPC without suspending", async () => {
    const { ctx, suspended, invokeMock } = makeInstallCtx();
    await dispatchSlashCommand(
      { command: "install", args: "/home/me/api" },
      ctx,
    );
    expect(suspended).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith(
      "setup.install_capture",
      { repo_path: "/home/me/api" },
      null,
    );
  });

  it("legacy path (no onSuspended) surfaces the catalog's error note", async () => {
    const { ctx, pushed } = makeCtx();
    await dispatchSlashCommand({ command: "install", args: "" }, ctx);
    const note = pushed.find((m) => m.role === "assistant");
    expect(note?.content).toMatch(/Path required/i);
  });
});

describe("/install — Phase 5.6 completion: project-link suspend", () => {
  function makeInstallCtxWithProjects(
    projects: Array<{ id: string; name: string; localPath: string | null }>,
  ): {
    ctx: SlashCtx;
    pushed: ChatMessage[];
    suspended: Array<{
      kind: string;
      name: string;
      path: string | undefined;
      rebuilt: string;
    }>;
    invokeMock: ReturnType<typeof vi.fn>;
  } {
    const pushed: ChatMessage[] = [];
    const suspended: Array<{
      kind: string;
      name: string;
      path: string | undefined;
      rebuilt: string;
    }> = [];
    const invokeMock = vi.fn(async () => okOutcome("Installed"));
    const ctx: SlashCtx = {
      appendMessage: (m) => pushed.push(m),
      sessionId: null,
      invoke: invokeMock,
      onSuspended: (state) => {
        const hint = state.needs.optionsHint;
        suspended.push({
          kind: state.needs.kind,
          name: state.needs.name,
          path: typeof hint?.path === "string" ? hint.path : undefined,
          rebuilt: state.rebuild({
            ...state.partial.collectedArgs,
            project_id: "wizard-minted",
          }),
        });
      },
      installDeps: {
        listProjects: async () => ({
          projects: projects.map((p) => ({ id: p.id, name: p.name })),
        }),
        getLocalPath: async (id) => {
          const p = projects.find((x) => x.id === id);
          return p?.localPath ?? null;
        },
      },
    };
    return { ctx, pushed, suspended, invokeMock };
  }

  it("valid path + no linked project → suspends with project_link slot carrying the path", async () => {
    const { ctx, suspended, invokeMock } = makeInstallCtxWithProjects([
      { id: "p-other", name: "Other", localPath: "D:\\other" },
    ]);
    await dispatchSlashCommand(
      { command: "install", args: "D:\\web" },
      ctx,
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(suspended).toHaveLength(1);
    expect(suspended[0]!.kind).toBe("project_link");
    expect(suspended[0]!.name).toBe("project_id");
    expect(suspended[0]!.path).toBe("D:\\web");
  });

  it("valid path + matching project (case-insensitive on Windows) → auto-injects project_id and dispatches", async () => {
    const { ctx, suspended, invokeMock } = makeInstallCtxWithProjects([
      { id: "p-match", name: "Web", localPath: "D:\\Web" }, // note casing
    ]);
    await dispatchSlashCommand(
      { command: "install", args: "d:\\web" }, // lower-case
      ctx,
    );
    expect(suspended).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith(
      "setup.install_capture",
      { repo_path: "d:\\web", project_id: "p-match" },
      null,
    );
  });

  it("valid path + matching project (POSIX exact match) → auto-injects project_id", async () => {
    const { ctx, invokeMock } = makeInstallCtxWithProjects([
      { id: "p-posix", name: "Api", localPath: "/home/me/api/" }, // trailing slash
    ]);
    await dispatchSlashCommand(
      { command: "install", args: "/home/me/api" },
      ctx,
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "setup.install_capture",
      { repo_path: "/home/me/api", project_id: "p-posix" },
      null,
    );
  });

  it("explicit --project=<id> is trusted (no probe, no suspend)", async () => {
    const { ctx, suspended, invokeMock } = makeInstallCtxWithProjects([
      // No projects exist for this path; user provided the id anyway.
    ]);
    await dispatchSlashCommand(
      { command: "install", args: "D:\\web --project=abc-explicit" },
      ctx,
    );
    expect(suspended).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith(
      "setup.install_capture",
      { repo_path: "D:\\web", project_id: "abc-explicit" },
      null,
    );
  });

  it("empty projects list → still suspends with project_link", async () => {
    const { ctx, suspended } = makeInstallCtxWithProjects([]);
    await dispatchSlashCommand(
      { command: "install", args: "D:\\web" },
      ctx,
    );
    expect(suspended).toHaveLength(1);
    expect(suspended[0]!.kind).toBe("project_link");
  });

  it("probe failure falls through to the catalog (degrades to pre-5.6 behavior)", async () => {
    const pushed: ChatMessage[] = [];
    const invokeMock = vi.fn(async () => okOutcome("Installed"));
    const ctx: SlashCtx = {
      appendMessage: (m) => pushed.push(m),
      sessionId: null,
      invoke: invokeMock,
      onSuspended: () => {
        throw new Error("must not suspend when probe fails");
      },
      installDeps: {
        listProjects: async () => {
          throw new Error("offline");
        },
        getLocalPath: async () => null,
      },
    };
    await dispatchSlashCommand(
      { command: "install", args: "D:\\web" },
      ctx,
    );
    // Catalog dispatched the tool without --project — same as the
    // pre-5.6 happy path (the tool surfaces its own error on cold
    // install with no wizard).
    expect(invokeMock).toHaveBeenCalledWith(
      "setup.install_capture",
      { repo_path: "D:\\web" },
      null,
    );
  });

  it("rebuild from project_link slot includes --project flag", async () => {
    const { ctx, suspended } = makeInstallCtxWithProjects([]);
    await dispatchSlashCommand(
      { command: "install", args: "D:\\web" },
      ctx,
    );
    expect(suspended[0]!.rebuilt).toContain("D:\\web");
    expect(suspended[0]!.rebuilt).toContain("--project=wizard-minted");
  });

  it("legacy callers (no onSuspended) skip the probe entirely", async () => {
    const probe = vi.fn();
    const { ctx, pushed } = makeCtx();
    ctx.installDeps = {
      listProjects: probe as never,
      getLocalPath: probe as never,
    };
    await dispatchSlashCommand(
      { command: "install", args: "D:\\web" },
      ctx,
    );
    // No probe call — legacy path stays cheap.
    expect(probe).not.toHaveBeenCalled();
    // And the catalog still ran.
    expect(pushed.some((m) => m.role === "assistant")).toBe(true);
  });
});

describe("findProjectByLocalPath", () => {
  it("returns the matching project (case-insensitive on Windows)", async () => {
    const { findProjectByLocalPath } = await import("../slash-dispatch");
    const result = await findProjectByLocalPath("D:\\web", {
      listProjects: async () => ({
        projects: [
          { id: "p-a", name: "A" },
          { id: "p-b", name: "B" },
        ],
      }),
      getLocalPath: async (id) =>
        id === "p-b" ? "d:\\WEB\\" /* normalised lower */ : "C:\\other",
    });
    expect(result).toEqual({ id: "p-b", name: "B" });
  });

  it("returns null when no project matches", async () => {
    const { findProjectByLocalPath } = await import("../slash-dispatch");
    const result = await findProjectByLocalPath("D:\\absent", {
      listProjects: async () => ({
        projects: [{ id: "p-a", name: "A" }],
      }),
      getLocalPath: async () => "D:\\other",
    });
    expect(result).toBeNull();
  });

  it("skips rows whose getLocalPath throws (and keeps probing)", async () => {
    const { findProjectByLocalPath } = await import("../slash-dispatch");
    const result = await findProjectByLocalPath("D:\\web", {
      listProjects: async () => ({
        projects: [
          { id: "p-flaky", name: "Flaky" },
          { id: "p-ok", name: "OK" },
        ],
      }),
      getLocalPath: async (id) => {
        if (id === "p-flaky") throw new Error("transient");
        return "D:\\web";
      },
    });
    expect(result).toEqual({ id: "p-ok", name: "OK" });
  });
});

describe("installRebuild — Phase 5.6 serializer", () => {
  it("emits `/install <path>` when no project flag is collected", async () => {
    const { installRebuild } = await import("../slash-dispatch");
    expect(installRebuild({ path: "D:\\web" })).toBe("/install D:\\web");
  });

  it("emits `/install <path> --project=<id>` when both are present", async () => {
    const { installRebuild } = await import("../slash-dispatch");
    expect(
      installRebuild({ path: "/x", project_id: "abc-123" }),
    ).toBe("/install /x --project=abc-123");
  });

  it("handles missing path gracefully (returns `/install  --project=…`)", async () => {
    const { installRebuild } = await import("../slash-dispatch");
    // Empty path collapses to the unparseable form; the dispatcher
    // will re-surface as "Path required" via the catalog. Tests pin
    // the serializer's behavior — production code never passes an
    // empty path through (the picker always returns a value).
    const out = installRebuild({ project_id: "x" });
    expect(out).toContain("/install");
    expect(out).toContain("--project=x");
  });
});
