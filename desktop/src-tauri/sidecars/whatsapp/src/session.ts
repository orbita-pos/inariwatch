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
import baileysPkg from "@whiskeysockets/baileys";
import type {
  AnyMessageContent,
  ConnectionState,
  WAMessage,
  WASocket,
} from "@whiskeysockets/baileys";

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = baileysPkg as unknown as {
  default: typeof import("@whiskeysockets/baileys")["default"];
  DisconnectReason: typeof import("@whiskeysockets/baileys")["DisconnectReason"];
  fetchLatestBaileysVersion: typeof import("@whiskeysockets/baileys")["fetchLatestBaileysVersion"];
};

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
    const toJid = e164ToJid(to);
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
    const auth = await loadBackedAuthState(this.cfg.accountDir);
    this.clearAuth = auth.clear;

    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: undefined as [number, number, number] | undefined,
    }));

    const socket = makeWASocket({
      auth: auth.state,
      printQRInTerminal: false,
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
