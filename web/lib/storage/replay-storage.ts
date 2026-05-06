/**
 * Replay V2 — block-based storage on Cloudflare R2 (S3-compatible).
 *
 * Each replay session is split into 30-second blocks (rrweb + I/O events
 * merged into one stream). Blocks are gzipped and uploaded under one of:
 *   {organization_id}/{session_id}/block_{NNNN}.json.gz   (org-scoped)
 *   users/{user_id}/{session_id}/block_{NNNN}.json.gz     (personal-scoped)
 *
 * The literal `users/` prefix can never collide with an org UUID (UUIDs
 * never start with letters in that pattern), so the two namespaces share
 * one bucket without ambiguity. The chosen prefix is also stored on the
 * `replay_sessions.r2_prefix` row at write time, so read paths can
 * reuse it directly without re-deriving the scope.
 *
 * Reads return either a signed URL (browser fetches directly from R2)
 * or a server-side decompressed payload (for AI processing jobs).
 *
 * If R2 env vars are missing, all calls throw — caller should gate behind
 * the REPLAY_V2 feature flag so unconfigured environments never hit this.
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { gzipSync, gunzipSync } from "node:zlib";

const BLOCK_DURATION_MS = 30_000;
const MAX_BLOCK_BYTES_RAW = 1_048_576; // 1 MB before compression
const MAX_BLOCK_EVENTS = 10_000;

/**
 * Tenant scope for a replay session. Discriminated union keeps the
 * call sites explicit — there's no ambiguity over whether a UUID
 * belongs to an org or a user.
 */
export type ReplayScope =
  | { kind: "org";  organizationId: string }
  | { kind: "user"; userId: string };

export interface ReplayBlockInput {
  scope: ReplayScope;
  sessionId: string;
  blockIndex: number;
  startMs: number;
  endMs: number;
  events: unknown[];
}

export interface SignedBlock {
  index: number;
  startMs: number;
  endMs: number;
  url: string;
}

let cachedClient: S3Client | null = null;

function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY missing)");
  }
  cachedClient = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cachedClient;
}

function getBucket(): string {
  const bucket = process.env.R2_BUCKET;
  if (!bucket) throw new Error("R2_BUCKET not configured");
  return bucket;
}

export function blockKey(prefix: string, blockIndex: number): string {
  return `${prefix}block_${String(blockIndex).padStart(4, "0")}.json.gz`;
}

/**
 * Build the R2 key prefix for a session.
 *
 * Overloads:
 *   - `sessionPrefix(scope, sessionId)`         — preferred, explicit scope
 *   - `sessionPrefix(organizationId, sessionId)` — legacy 2-arg form, treated
 *     as `{ kind: "org", organizationId }`. Kept for backward compatibility
 *     with existing scripts and DB-stored prefixes from before the
 *     personal-workspace path shipped.
 */
export function sessionPrefix(scope: ReplayScope, sessionId: string): string;
export function sessionPrefix(organizationId: string, sessionId: string): string;
export function sessionPrefix(scopeOrOrgId: ReplayScope | string, sessionId: string): string {
  if (typeof scopeOrOrgId === "string") {
    return `${scopeOrOrgId}/${sessionId}/`;
  }
  if (scopeOrOrgId.kind === "user") {
    return `users/${scopeOrOrgId.userId}/${sessionId}/`;
  }
  return `${scopeOrOrgId.organizationId}/${sessionId}/`;
}

/**
 * Upload a single block. Returns the R2 key and the compressed byte size.
 * Throws if the block exceeds size/event limits — caller must validate.
 */
export async function uploadBlock(input: ReplayBlockInput): Promise<{ key: string; bytes: number }> {
  if (input.events.length > MAX_BLOCK_EVENTS) {
    throw new Error(`Block exceeds max ${MAX_BLOCK_EVENTS} events`);
  }
  const raw = JSON.stringify(input.events);
  if (raw.length > MAX_BLOCK_BYTES_RAW) {
    throw new Error(`Block exceeds max ${MAX_BLOCK_BYTES_RAW} bytes (raw)`);
  }

  const compressed = gzipSync(raw, { level: 6 });
  const prefix = sessionPrefix(input.scope, input.sessionId);
  const key = blockKey(prefix, input.blockIndex);

  await getClient().send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Body: compressed,
    ContentType: "application/json",
    ContentEncoding: "gzip",
    Metadata: {
      "session-id": input.sessionId,
      "block-index": String(input.blockIndex),
      "start-ms": String(input.startMs),
      "end-ms": String(input.endMs),
    },
  }));

  return { key, bytes: compressed.length };
}

/**
 * Generate a signed URL for a block. Default TTL 5 min.
 * The browser fetches directly from R2, decompresses (gzip is transparent
 * with ContentEncoding header), and feeds events into rrweb Replayer.
 */
export async function getBlockSignedUrl(key: string, ttlSec: number = 300): Promise<string> {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: getBucket(), Key: key }),
    { expiresIn: ttlSec },
  );
}

/**
 * Generate signed URLs for every block in a session. Used by the manifest
 * endpoint. The caller passes the stored `replay_sessions.r2_prefix`
 * directly so this function works for any scope (org or personal) without
 * having to re-derive the prefix.
 */
export async function getSessionBlockUrlsByPrefix(
  prefix: string,
  blockCount: number,
  ttlSec: number = 300,
): Promise<SignedBlock[]> {
  const blocks: SignedBlock[] = [];
  for (let i = 0; i < blockCount; i++) {
    const url = await getBlockSignedUrl(blockKey(prefix, i), ttlSec);
    blocks.push({
      index: i,
      startMs: i * BLOCK_DURATION_MS,
      endMs: (i + 1) * BLOCK_DURATION_MS,
      url,
    });
  }
  return blocks;
}

/**
 * Legacy 2-arg form. Kept for tests and any caller that hasn't migrated to
 * passing the stored `r2_prefix`. New code should call
 * `getSessionBlockUrlsByPrefix` instead.
 */
export async function getSessionBlockUrls(
  organizationId: string,
  sessionId: string,
  blockCount: number,
  ttlSec: number = 300,
): Promise<SignedBlock[]> {
  return getSessionBlockUrlsByPrefix(sessionPrefix(organizationId, sessionId), blockCount, ttlSec);
}

/**
 * Server-side fetch + decompress of a block. For AI processing jobs that
 * need to walk the full event stream.
 */
export async function fetchBlock(key: string): Promise<unknown[]> {
  const resp = await getClient().send(new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
  }));
  if (!resp.Body) throw new Error(`Block not found: ${key}`);
  const buf = Buffer.from(await resp.Body.transformToByteArray());
  return JSON.parse(gunzipSync(buf).toString("utf8"));
}

/**
 * Delete every block under a session prefix. Used for retention sweeps and
 * GDPR delete requests. Returns the number of objects deleted.
 *
 * Takes the stored `replay_sessions.r2_prefix` directly so it works for
 * any scope (org or personal) without having to re-derive it.
 */
export async function deleteSessionByPrefix(prefix: string): Promise<number> {
  const client = getClient();
  const bucket = getBucket();

  const list = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  const objects = list.Contents ?? [];
  if (objects.length === 0) return 0;

  await client.send(new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: { Objects: objects.map((o) => ({ Key: o.Key! })) },
  }));
  return objects.length;
}

/**
 * Legacy 2-arg form. Kept for callers that still hold (orgId, sessionId)
 * rather than the stored prefix. New code should call
 * `deleteSessionByPrefix` instead.
 */
export async function deleteSession(organizationId: string, sessionId: string): Promise<number> {
  return deleteSessionByPrefix(sessionPrefix(organizationId, sessionId));
}

export const REPLAY_LIMITS = {
  BLOCK_DURATION_MS,
  MAX_BLOCK_BYTES_RAW,
  MAX_BLOCK_EVENTS,
} as const;
