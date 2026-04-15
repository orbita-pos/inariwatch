/**
 * Replay V2 — block-based storage on Cloudflare R2 (S3-compatible).
 *
 * Each replay session is split into 30-second blocks (rrweb + I/O events
 * merged into one stream). Blocks are gzipped and uploaded to:
 *   {workspace_id}/{session_id}/block_{NNNN}.json.gz
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

export interface ReplayBlockInput {
  organizationId: string;
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

export function sessionPrefix(organizationId: string, sessionId: string): string {
  return `${organizationId}/${sessionId}/`;
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
  const prefix = sessionPrefix(input.organizationId, input.sessionId);
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
 * Generate signed URLs for every block in a session. Used by the manifest endpoint.
 */
export async function getSessionBlockUrls(
  organizationId: string,
  sessionId: string,
  blockCount: number,
  ttlSec: number = 300,
): Promise<SignedBlock[]> {
  const prefix = sessionPrefix(organizationId, sessionId);
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
 */
export async function deleteSession(organizationId: string, sessionId: string): Promise<number> {
  const prefix = sessionPrefix(organizationId, sessionId);
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

export const REPLAY_LIMITS = {
  BLOCK_DURATION_MS,
  MAX_BLOCK_BYTES_RAW,
  MAX_BLOCK_EVENTS,
} as const;
