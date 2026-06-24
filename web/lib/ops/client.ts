/**
 * Tiny helper for the /admin/ops page. Server-only: never import from a
 * client component because it reads OPS_AGENT_SECRET.
 */

import "server-only";

export type Box = "inari-staging" | "inari-web";

const OPS_URLS: Record<Box, string | undefined> = {
  "inari-staging": process.env.OPS_URL_STAGING,
  "inari-web": process.env.OPS_URL_WEB,
};

export type OpsResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export async function fetchOps<T = unknown>(
  box: Box,
  path: string,
  opts: { revalidate?: number } = {},
): Promise<OpsResult<T>> {
  const url = OPS_URLS[box];
  if (!url) {
    return { ok: false, error: `OPS_URL for ${box} not configured` };
  }
  const secret = process.env.OPS_AGENT_SECRET;
  if (!secret) {
    return { ok: false, error: "OPS_AGENT_SECRET not configured" };
  }
  try {
    const res = await fetch(`${url}${path}`, {
      headers: { Authorization: `Bearer ${secret}` },
      next: { revalidate: opts.revalidate ?? 30 },
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} from ${box}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export const BOXES: Box[] = ["inari-staging", "inari-web"];

export function boxLabel(box: Box): string {
  return box === "inari-staging" ? "staging" : "web";
}
