// v0.3 S5 — per-account Baileys session.
//
// One `Session` instance per linked WhatsApp account. The session owns
// its socket, its auth state, and its reconnect lifecycle. It does NOT
// own the JSON-RPC plumbing (that's `main.ts`) or persistence beyond
// what's in `auth-store.ts`.
//
// External callers interact through three methods:
//
//   - `start()`  — kick off the connection. Emits `qr_update` events
//                  until the user pairs, then `linked`. Promise resolves
//                  once the socket is `open` OR the backoff is
//                  exhausted (in which case `failed` was emitted).
//   - `send(...)` — fire a single text message. Throws when the socket
//                   is closed; the manager retries via JSON-RPC errors.
//   - `logout()` — close the socket, emit `logged_out`, wipe creds.

import { Boom } from "@hapi/boom";
import pino from "pino";
// Use a namespace import so we get the actual module record and can
// pick whichever export shape this Baileys version uses. v6 published
// makeWASocket as the default export; v7 publishes it as a named
// export AND keeps default as an alias. The ESM <-> CJS interop for
// the ".default" chain isn't reliable across both, so we resolve
// dynamically below.
import * as baileysPkg from "@whiskeysockets/baileys";
import type {
  AnyMessageContent,
  ConnectionState,
  WAMessage,
  WASocket,
} from "@whiskeysockets/baileys";

// Baileys v7 ships TWO version-fetch helpers (only one in older releases):
//   * `fetchLatestBaileysVersion` — the historical name, still exported as
//     an alias in v7 but the underlying source URL drifts; calling it
//     yields a corrupted tertiary version number that WhatsApp servers
//     silently reject (the `connected to WA` handshake completes, the
//     registration node is sent, then the server stops responding to
//     anything except keep-alive pings). Observed firsthand 2026-05-10.
//   * `fetchLatestWaWebVersion` — added in v7. Hits the official
//     WhatsApp Web update endpoint and returns the canonical triple
//     `[2, 3000, X]` that the server expects.
// We prefer the new helper. Both feature-detected so a future Baileys
// release that drops one keeps working with the other.
const baileysExports = baileysPkg as unknown as {
  default?: typeof import("@whiskeysockets/baileys")["default"];
  makeWASocket?: typeof import("@whiskeysockets/baileys")["default"];
  DisconnectReason: typeof import("@whiskeysockets/baileys")["DisconnectReason"];
  fetchLatestBaileysVersion?: () => Promise<{ version: [number, number, number] }>;
  fetchLatestWaWebVersion?: () => Promise<{ version: [number, number, number] }>;
};
// v7 named export takes priority; fall back to default for older
// Baileys releases. Throwing here would leave the supervisor in a
// tight reconnect loop, so cast to the function type and let the
// connect attempt surface a clearer error if neither is present.
const makeWASocket = (baileysExports.makeWASocket ??
  baileysExports.default) as typeof import("@whiskeysockets/baileys")["default"];
const { DisconnectReason } = baileysExports;

import { Backoff } from "./connection.js";
import { loadBackedAuthState } from "./auth-store.js";
import type { ConnectionStatus, WhatsAppEvent } from "./types.js";

export type EventEmitter = (event: WhatsAppEvent) => void;

export interface SessionConfig {
  accountId: string;
  label: string;
  /** Per-account dir under the manager's auth-root. */
  accountDir: string;
  /** Where the manager pipes events back to main.ts. */
  emit: EventEmitter;
}

export class Session {
  private socket: WASocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private selfJid: string | null = null;
  private backoff = new Backoff(5);
  private clearAuth: (() => Promise<void>) | null = null;
  private shutdownRequested = false;

  constructor(private readonly cfg: SessionConfig) {}

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getSelfJid(): string | null {
    return this.selfJid;
  }

  /** Start the connection lifecycle. Resolves once we're either
   *  `connected` or `failed`. */
  async start(): Promise<void> {
    this.shutdownRequested = false;
    while (!this.shutdownRequested) {
      try {
        await this.connectOnce();
        // connectOnce resolves when `connection.update` fires `open`.
        // The socket then runs forever until peer-close or shutdown;
        // wait for that close event before reconnecting.
        await this.waitForCloseOrShutdown();
      } catch (err) {
        this.transition("reconnecting");
        process.stderr.write(
          `[whatsapp-sidecar] account ${this.cfg.accountId} connect error: ${String(
            err,
          )}\n`,
        );
      }
      if (this.shutdownRequested) return;
      if (this.backoff.exhausted()) {
        this.transition("failed");
        this.cfg.emit({
          type: "fatal",
          account_id: this.cfg.accountId,
          message: "Reconnect attempts exhausted; click Reconnect to retry.",
          ts_ms: Date.now(),
        });
        return;
      }
      const sleepMs = this.backoff.next();
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  async send(
    to: string,
    body: string,
    replyTo?: string,
  ): Promise<{ messageId: string; toJid: string }> {
    if (!this.socket || this.status !== "connected") {
      throw new Error("not connected");
    }

    // Resolve the recipient against the WhatsApp registry BEFORE
    // sending. Two reasons:
    //
    //  1. Baileys' `sendMessage` returns a `messageId` as soon as the
    //     payload is queued locally — NOT when it's delivered. Sending
    //     to a number that isn't on WhatsApp produces a perfectly
    //     valid-looking response that goes nowhere, so callers see
    //     "Sent" while the recipient never receives anything.
    //  2. Mexican mobile numbers registered before ~2022 have a
    //     canonical JID with a "1" inserted between country code and
    //     area code (e.g. `+526691234567` → `5216691234567@s.whatsapp.net`).
    //     If we send to `526691234567@s.whatsapp.net` (the literal
    //     digit-strip), WhatsApp routes the message into a black
    //     hole. `onWhatsApp` returns the canonical JID so we don't
    //     have to encode legacy-numbering rules in the client.
    //
    // The handshake adds one round-trip per send (~200ms on a warm
    // socket); acceptable for the slash-command use case where the
    // tradeoff against silent failure is no contest.
    //
    // We hand the typed-in phone (with `+`) straight to `onWhatsApp`
    // rather than pre-converting via `e164ToJid` — Baileys accepts
    // both forms and the JID it returns is the canonical one, so any
    // local conversion would be redundant.
    const lookups = await this.socket.onWhatsApp(to);
    const match = lookups?.find((row) => row.exists);
    if (!match) {
      throw new Error(`'${to}' is not on WhatsApp`);
    }
    const toJid = match.jid;

    const content: AnyMessageContent = { text: body };
    let msg: WAMessage | undefined;
    if (replyTo) {
      msg = await this.socket.sendMessage(toJid, content, {
        quoted: { key: { id: replyTo, remoteJid: toJid, fromMe: false }, message: undefined },
      });
    } else {
      msg = await this.socket.sendMessage(toJid, content);
    }
    const messageId = msg?.key?.id;
    if (!messageId) {
      throw new Error("baileys did not return a message id");
    }
    return { messageId, toJid };
  }

  async logout(): Promise<void> {
    this.shutdownRequested = true;
    try {
      await this.socket?.logout();
    } catch {
      // Ignore — we're shutting this down anyway.
    }
    if (this.clearAuth) {
      await this.clearAuth();
    }
    this.transition("disconnected");
    this.selfJid = null;
    this.cfg.emit({
      type: "logged_out",
      account_id: this.cfg.accountId,
      ts_ms: Date.now(),
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private transition(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.cfg.emit({
      type: "connection_state_changed",
      account_id: this.cfg.accountId,
      status,
      ts_ms: Date.now(),
    });
  }

  private async connectOnce(): Promise<void> {
    process.stderr.write(
      `[whatsapp-sidecar] account ${this.cfg.accountId} connectOnce begin (makeWASocket=${typeof makeWASocket})\n`,
    );
    const auth = await loadBackedAuthState(this.cfg.accountDir);
    this.clearAuth = auth.clear;

    let version: [number, number, number] | undefined;
    // Prefer the v7 web-version helper; fall back to the legacy one.
    const versionFetcher =
      baileysExports.fetchLatestWaWebVersion ?? baileysExports.fetchLatestBaileysVersion;
    if (typeof versionFetcher === "function") {
      try {
        const result = await versionFetcher();
        version = result.version;
        process.stderr.write(
          `[whatsapp-sidecar] WA web version=${version.join(".")}\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[whatsapp-sidecar] version fetch failed (using bundled default): ${String(err)}\n`,
        );
      }
    }

    // Baileys v7 expects a pino logger; without one some internal
    // paths attempt `.error()` / `.info()` on undefined and silently
    // wedge before emitting the QR. We pipe logger output through our
    // own stderr at info level so issues surface in the Tauri log.
    const logger = pino({
      level: process.env.BAILEYS_LOG_LEVEL ?? "warn",
    }, pino.destination(2));

    // Some `MakeWASocket` option names changed across Baileys releases
    // (e.g. `printQRInTerminal` was removed in v7). Casting through
    // `any` lets us keep backwards-compatible options without the
    // type system rejecting v6-only fields. Runtime ignores unknown
    // keys.
    const socket = makeWASocket({
      auth: auth.state,
      logger: logger as unknown as Parameters<typeof makeWASocket>[0]["logger"],
      // Mark as a desktop client (matches Inari Live's identity).
      browser: ["Inari Live", "Desktop", "0.3.0"],
      ...(version ? { version } : {}),
      // We don't need WAM (analytics) — opt out so Meta sees less.
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    this.socket = socket;
    socket.ev.on("creds.update", async () => {
      try {
        await auth.saveCreds();
      } catch (err) {
        process.stderr.write(
          `[whatsapp-sidecar] saveCreds failed: ${String(err)}\n`,
        );
      }
    });

    // v0.3 S8 — inbound DM handler. Drops:
    //   - non-`notify` upserts (history sync replays, etc.)
    //   - group JIDs (`@g.us`)
    //   - non-text shapes (image/audio/video/sticker/etc.)
    //   - sender-side echoes when the user typed in the WhatsApp app
    //     itself (`key.fromMe` true)
    //
    // Forwards remaining text DMs to the Rust manager via the same
    // `event` notification channel as qr_update / linked.
    socket.ev.on("messages.upsert", (upsert: { messages: WAMessage[]; type?: string }) => {
      // Baileys' `type` is `"notify"` for new live messages and
      // `"append"` for history sync replays. We only want the former.
      if (upsert.type !== "notify") return;
      for (const msg of upsert.messages) {
        const remoteJid = msg.key.remoteJid ?? "";
        const isGroup = remoteJid.endsWith("@g.us");
        const fromMe = msg.key.fromMe ?? false;
        const messageId = msg.key.id ?? "";
        if (!messageId) continue;
        // Extract a plain-text body. Baileys exposes a few shapes —
        // we accept `conversation` (the simple case) and
        // `extendedTextMessage.text` (replies / quoted / mentions).
        const text =
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          null;
        if (text === null || text === undefined || text === "") continue;
        const tsRaw = (msg.messageTimestamp as number | undefined) ?? Math.floor(Date.now() / 1000);
        const tsMs = typeof tsRaw === "number" ? tsRaw * 1000 : Date.now();
        this.cfg.emit({
          type: "message_received",
          account_id: this.cfg.accountId,
          from_jid: remoteJid,
          push_name: msg.pushName ?? null,
          text,
          message_id: messageId,
          ts_ms: tsMs,
          from_me: fromMe,
          is_group: isGroup,
        });
      }
    });

    await new Promise<void>((resolve, reject) => {
      socket.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update as Partial<ConnectionState>;
        if (qr) {
          this.transition("qr_pending");
          this.cfg.emit({
            type: "qr_update",
            account_id: this.cfg.accountId,
            qr,
            ts_ms: Date.now(),
          });
        }
        if (connection === "open") {
          this.backoff.reset();
          this.selfJid = socket.user?.id ?? null;
          this.transition("connected");
          if (this.selfJid) {
            this.cfg.emit({
              type: "linked",
              account_id: this.cfg.accountId,
              self_jid: this.selfJid,
              ts_ms: Date.now(),
            });
          }
          resolve();
        }
        if (connection === "close") {
          const reason =
            lastDisconnect?.error instanceof Boom
              ? lastDisconnect.error.output.statusCode
              : 0;
          if (reason === DisconnectReason.loggedOut) {
            // User logged out from another device — wipe creds + bail.
            void this.clearAuth?.();
            this.shutdownRequested = true;
            this.transition("disconnected");
            this.cfg.emit({
              type: "logged_out",
              account_id: this.cfg.accountId,
              ts_ms: Date.now(),
            });
            return reject(new Error(`logged_out`));
          }
          this.transition("reconnecting");
          return reject(new Error(`connection closed (reason ${reason})`));
        }
      });
    });
  }

  private async waitForCloseOrShutdown(): Promise<void> {
    return new Promise((resolve) => {
      const sock = this.socket;
      if (!sock) {
        resolve();
        return;
      }
      const closeHandler = (update: Partial<ConnectionState>) => {
        if (update.connection === "close") {
          sock.ev.off("connection.update", closeHandler);
          resolve();
        }
      };
      sock.ev.on("connection.update", closeHandler);
    });
  }
}

// E.164 (no leading +) → Baileys JID for WhatsApp DMs.
// Group JIDs end in `@g.us` — out of scope for v0.3.
export function e164ToJid(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length < 6) {
    throw new Error(`invalid phone number: '${phone}'`);
  }
  return `${digits}@s.whatsapp.net`;
}
