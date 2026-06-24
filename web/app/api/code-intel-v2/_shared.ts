/**
 * Shared helpers for the /api/code-intel-v2/* endpoints. These run with
 * Bearer CRON_SECRET auth — matches the existing worker → web pattern
 * used by /api/replay/[sessionId]/analyze (the BullMQ worker authenticates
 * with the same secret).
 *
 * The endpoints are an HTTP shim around web/lib/code-intelligence-v2/queries.ts,
 * intended for the container-agent worker to call from Hetzner. They accept
 * a `projectId` (which the worker has) and resolve to `repoId` server-side
 * so the worker doesn't need to track a separate repo identity.
 */

import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { firstReadyRepoForProject } from "@/lib/services/code-intelligence.service";

export function authorize(req: NextRequest): NextResponse | null {
  // Read CRON_SECRET at request time so test env mutations land. The same
  // pattern as /api/replay/[sessionId]/analyze (Phase 1.6 mirrors that
  // endpoint's auth shape).
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!cronSecret || !auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  const received = Buffer.from(auth);
  const valid =
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received);
  if (!valid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function resolveRepoId(input: {
  repoId?: string;
  projectId?: string;
}): Promise<string | null> {
  if (input.repoId) return input.repoId;
  if (!input.projectId) return null;
  return firstReadyRepoForProject(input.projectId);
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}
