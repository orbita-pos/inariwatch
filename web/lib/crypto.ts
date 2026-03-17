import crypto from "crypto";

const KEY_HEX = process.env.ENCRYPTION_KEY ?? "";

function getKey(): Buffer {
  return Buffer.from(KEY_HEX, "hex");
}

function hasKey(): boolean {
  return KEY_HEX.length === 64;
}

// Fail loudly in production if encryption key is missing
if (process.env.NODE_ENV === "production" && !hasKey()) {
  throw new Error(
    "ENCRYPTION_KEY is not set. All integration tokens would be stored in plaintext. " +
    "Generate one with: openssl rand -hex 32"
  );
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns a string in the format `enc:<iv_hex>:<tag_hex>:<ct_hex>`.
 * Falls back to returning the plaintext unchanged if ENCRYPTION_KEY is not set
 * (development convenience — never deploy without a key).
 */
export function encrypt(plaintext: string): string {
  if (!hasKey()) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

/**
 * Decrypt a string produced by `encrypt`.
 * Passes through unchanged strings that don't start with `enc:` so that
 * legacy plaintext rows continue to work after the key is first deployed.
 */
export function decrypt(stored: string): string {
  if (!stored.startsWith("enc:")) return stored;
  const parts = stored.split(":");
  if (parts.length !== 4) return stored;
  const iv  = Buffer.from(parts[1], "hex");
  const tag = Buffer.from(parts[2], "hex");
  const ct  = Buffer.from(parts[3], "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct).toString("utf8") + decipher.final("utf8");
}

/**
 * Encrypt an arbitrary JSON-serialisable config object.
 * Stores the result as `{ _enc: "enc:..." }` inside a JSONB column so that
 * the ciphertext is opaque but the column still holds valid JSON.
 * No-ops when ENCRYPTION_KEY is not set.
 */
export function encryptConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (!hasKey()) return config;
  return { _enc: encrypt(JSON.stringify(config)) };
}

/**
 * Decrypt a config that was stored with `encryptConfig`.
 * Falls back to returning the object as-is when it has no `_enc` key
 * (backwards compatibility with plaintext rows written before encryption was enabled).
 */
export function decryptConfig(stored: unknown): Record<string, unknown> {
  if (!stored || typeof stored !== "object") return {};
  const obj = stored as Record<string, unknown>;
  if (typeof obj._enc === "string") {
    try {
      return JSON.parse(decrypt(obj._enc)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return obj;
}
