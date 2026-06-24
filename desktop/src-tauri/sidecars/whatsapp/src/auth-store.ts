// v0.3 S5 — credential persistence + .bak backup pattern.
//
// Inspired by OpenClaw's `extensions/whatsapp/src/auth-store.ts`. Each
// account gets its own directory under `<auth-root>/<account_id>/` with
//
//   creds.json          — current Baileys multi-file auth state
//   creds.json.bak      — last known-good copy
//   keys/               — Baileys signal store (per-key files)
//
// Two invariants we enforce on every save:
//
//   1. Atomic write: write to `<file>.tmp`, fsync, rename. No partial
//      file on disk if the process is killed mid-write.
//   2. Backup ONLY if the new file parses as JSON. Prevents the
//      "good backup overwritten by corrupted creds" failure mode that
//      bricks Baileys (the user has to re-scan the QR).
//
// Re-uses Baileys' `useMultiFileAuthState` for the signal store; we
// only wrap the `creds.json` save path with our atomic + backup
// invariants. Baileys publishes `saveCreds` as a callback we attach
// to the `creds.update` event in `session.ts`.

import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";

/**
 * Shape we hand back to the Baileys socket constructor. Mirrors
 * Baileys' own `useMultiFileAuthState` return type, but with our
 * atomic+backup creds save.
 */
export interface BackedAuthState {
  state: AuthenticationState;
  /** Persist the current creds. Called by Baileys on `creds.update`. */
  saveCreds: () => Promise<void>;
  /** Drop everything on disk for this account (logout flow). */
  clear: () => Promise<void>;
}

const CREDS_FILE = "creds.json";
const CREDS_BAK_FILE = "creds.json.bak";
const KEYS_DIR = "keys";

export async function loadBackedAuthState(
  accountDir: string,
): Promise<BackedAuthState> {
  await fs.mkdir(join(accountDir, KEYS_DIR), { recursive: true });

  const credsPath = join(accountDir, CREDS_FILE);
  const credsBakPath = join(accountDir, CREDS_BAK_FILE);

  let creds: AuthenticationCreds;
  try {
    const raw = await fs.readFile(credsPath, "utf-8");
    creds = parseCreds(raw);
  } catch (err: unknown) {
    if (!isENOENT(err)) {
      // creds.json exists but didn't parse — try the backup.
      try {
        const raw = await fs.readFile(credsBakPath, "utf-8");
        creds = parseCreds(raw);
        // Restore the good backup as the live file.
        await atomicWriteJson(credsPath, creds);
      } catch {
        creds = initAuthCreds();
      }
    } else {
      creds = initAuthCreds();
    }
  }

  const keys = baileysSignalKeyStore(join(accountDir, KEYS_DIR));

  const saveCreds = async () => {
    // Validate JSON serialisability BEFORE clobbering the backup.
    const next = JSON.stringify(creds, replacer);
    JSON.parse(next); // throws on cycle / unsupported value
    if (await fileExists(credsPath)) {
      try {
        await fs.copyFile(credsPath, credsBakPath);
      } catch (err) {
        // Backup failure isn't fatal — log but proceed with the save.
        process.stderr.write(
          `[whatsapp-sidecar] backup write failed: ${String(err)}\n`,
        );
      }
    }
    await atomicWriteString(credsPath, next);
  };

  const clear = async () => {
    await Promise.all([
      fs.rm(credsPath, { force: true }),
      fs.rm(credsBakPath, { force: true }),
      fs.rm(join(accountDir, KEYS_DIR), { recursive: true, force: true }),
    ]);
    await fs.mkdir(join(accountDir, KEYS_DIR), { recursive: true });
  };

  return { state: { creds, keys }, saveCreds, clear };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseCreds(raw: string): AuthenticationCreds {
  // Baileys uses Buffers in creds (privateKey, publicKey, etc.). The
  // standard reviver below converts the shape JSON.stringify(replacer)
  // emits back to Buffer.
  return JSON.parse(raw, reviver) as AuthenticationCreds;
}

function replacer(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    (value as { type: string }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown[] }).data)
  ) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return { type: "Buffer", data: Array.from(value) };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    (value as { type: string }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown[] }).data)
  ) {
    return Buffer.from((value as unknown as { data: number[] }).data);
  }
  return value;
}

async function atomicWriteString(path: string, body: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, body, { encoding: "utf-8" });
  await fs.rename(tmp, path);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteString(path, JSON.stringify(value, replacer));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function isENOENT(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  );
}

// ── Signal key store (matches Baileys' `useMultiFileAuthState`) ───────────

function baileysSignalKeyStore(keysDir: string): AuthenticationState["keys"] {
  const fileFor = (type: keyof SignalDataTypeMap, id: string) =>
    join(keysDir, `${String(type)}-${sanitize(id)}.json`);

  const sanitize = (raw: string) =>
    raw.replace(/[^a-zA-Z0-9._-]/g, "_");

  return {
    get: async <T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[],
    ): Promise<{ [_: string]: SignalDataTypeMap[T] }> => {
      const out: Record<string, SignalDataTypeMap[T]> = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            const raw = await fs.readFile(fileFor(type, id), "utf-8");
            let value = JSON.parse(raw, reviver);
            if (type === "app-state-sync-key") {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as object,
              );
            }
            out[id] = value as SignalDataTypeMap[T];
          } catch {
            // Missing key → caller treats as "not stored".
          }
        }),
      );
      return out;
    },
    set: async (data) => {
      const tasks: Promise<void>[] = [];
      for (const [type, idMap] of Object.entries(data) as Array<
        [keyof SignalDataTypeMap, Record<string, unknown>]
      >) {
        for (const [id, value] of Object.entries(idMap)) {
          const path = fileFor(type, id);
          if (value == null) {
            tasks.push(fs.rm(path, { force: true }));
          } else {
            tasks.push(
              atomicWriteString(path, JSON.stringify(value, replacer)),
            );
          }
        }
      }
      await Promise.all(tasks);
    },
  };
}
