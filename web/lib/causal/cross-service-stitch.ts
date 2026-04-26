/**
 * Cross-service causal graph stitcher — server-side merge of subgraphs
 * emitted by separate services that share an `X-IW-Session-Id`.
 *
 * Why this exists:
 *   - The SDK already merges in-process: the HTTP outbound hook reads the
 *     `X-IW-Subgraph` response header and inlines the downstream service's
 *     subgraph into the upstream caller's payload before the throw fires.
 *   - That covers the synchronous-RPC case but not the asynchronous one:
 *     ServiceA fires an event into a queue, ServiceB throws ten seconds
 *     later while processing it. ServiceA's payload never sees the response,
 *     yet both alerts share the same session id and want to be one graph
 *     in the dashboard / AI prompt.
 *
 * Design rules:
 *   - Pure function over alert rows. Caller passes the alert plus its
 *     session-mate alerts (looked up by `alerts.sessionId`). We don't query
 *     the DB here so the merge logic stays unit-testable without a database.
 *   - Cap = 200 nodes total (matches the SDK-side cap in capture/causal/graph.ts).
 *     If the merged graph would exceed, foreign nodes are truncated from
 *     the END of the foreign array (latest = closest to the throw frame
 *     in the foreign service = highest causal value to the AI).
 *   - Foreign node ids get a `<service>:` prefix so they can never collide
 *     with the local ids and so the rendered graph keeps service attribution.
 *   - Idempotent. Calling the merge twice with the same inputs produces
 *     the same output.
 *
 * Mirrors the SDK helper `mergeSubgraph` in
 * `capture/src/causal/graph.ts` so a graph stitched here in the server is
 * indistinguishable from one stitched in-process — same id format, same cap.
 *
 * Mirrors the eBPF stitching pattern (see project_ebpf_agent.md) where each
 * agent's events carry a session id and the cloud-side processor joins them
 * across hosts via that same id.
 */
import type { CausalGraph, CausalGraphNode, CausalGraphEdge } from "./types";

const MAX_NODES = 200;

export interface StitchInputAlert {
  id: string;
  sessionId: string | null;
  /** The service this alert came from — used as the foreign-id prefix. */
  origin?: string | null;
  graph: CausalGraph | null;
  /** Optional — if present, foreign roots get a causal edge from this id. */
  rootNodeId?: string | null;
}

export interface StitchResult {
  graph: CausalGraph;
  /** ids of services whose subgraphs were merged in. */
  origins: string[];
  /** total foreign nodes accepted (post-cap). */
  merged: number;
  /** total foreign nodes dropped because the cap was already reached. */
  skipped: number;
}

/**
 * Merge `primary`'s graph with each of `siblings`' graphs, returning a single
 * stitched `CausalGraph`. The primary keeps its ids unchanged; each sibling
 * is namespaced with its `origin` (or its alert id, as a fallback).
 *
 * If `primary.graph` is null, the result is the union of siblings starting
 * from an empty graph — useful when the upstream alert has no graph but the
 * downstream services do.
 */
export function stitchCrossServiceGraphs(
  primary: StitchInputAlert,
  siblings: StitchInputAlert[],
): StitchResult {
  const nodes: CausalGraphNode[] = primary.graph?.nodes
    ? [...primary.graph.nodes]
    : [];
  const edges: CausalGraphEdge[] = primary.graph?.edges
    ? [...primary.graph.edges]
    : [];
  const seenNodeIds = new Set(nodes.map((n) => n.id));

  const origins: string[] = [];
  let merged = 0;
  let skipped = 0;

  for (const sib of siblings) {
    if (!sib.graph?.nodes?.length) continue;
    if (sib.sessionId && primary.sessionId && sib.sessionId !== primary.sessionId) {
      // Defensive — caller is supposed to pre-filter by sessionId, but a
      // foreign session leaking in here would silently corrupt a graph.
      continue;
    }
    const remaining = MAX_NODES - nodes.length;
    if (remaining <= 0) {
      skipped += sib.graph.nodes.length;
      continue;
    }

    const prefix = sib.origin?.trim() || sib.id.slice(0, 8);
    origins.push(prefix);

    const incoming = sib.graph.nodes.slice(-remaining);
    const accepted = new Set(incoming.map((n) => n.id));
    skipped += sib.graph.nodes.length - incoming.length;

    const idMap = new Map<string, string>();
    for (const fn of incoming) {
      const localId = `${prefix}:${fn.id}`;
      idMap.set(fn.id, localId);
      if (seenNodeIds.has(localId)) continue;
      seenNodeIds.add(localId);
      nodes.push({
        id: localId,
        kind: fn.kind,
        label: `[${prefix}] ${fn.label}`,
      });
      merged++;
    }

    const inboundCount = new Map<string, number>();
    for (const fe of sib.graph.edges) {
      if (!accepted.has(fe.from) || !accepted.has(fe.to)) continue;
      inboundCount.set(fe.to, (inboundCount.get(fe.to) ?? 0) + 1);
    }

    for (const fe of sib.graph.edges) {
      if (!accepted.has(fe.from) || !accepted.has(fe.to)) continue;
      const from = idMap.get(fe.from);
      const to = idMap.get(fe.to);
      if (!from || !to) continue;
      edges.push({ from, to, kind: fe.kind });
    }

    // Stitch edge from the upstream root to each foreign root (a foreign
    // node with no inbound edge inside the foreign graph).
    if (primary.rootNodeId && seenNodeIds.has(primary.rootNodeId)) {
      for (const fn of incoming) {
        if ((inboundCount.get(fn.id) ?? 0) > 0) continue;
        const localId = idMap.get(fn.id);
        if (!localId) continue;
        edges.push({ from: primary.rootNodeId, to: localId, kind: "causal" });
      }
    }
  }

  return { graph: { nodes, edges }, origins, merged, skipped };
}

/**
 * Pull the `graph` payload off an alert's correlationData (where the
 * capture webhook persists it under `correlationData.graph` for v2 events).
 * Returns null when shape is invalid — callers fall back to the raw alert.
 */
export function extractGraphFromCorrelationData(
  correlationData: unknown,
): CausalGraph | null {
  if (!correlationData || typeof correlationData !== "object") return null;
  const data = correlationData as Record<string, unknown>;
  // v2 wire shape stores the graph as `graph`. Older builds used
  // `causalGraph`. Accept either.
  const candidate = (data.graph ?? data.causalGraph) as unknown;
  if (!candidate || typeof candidate !== "object") return null;
  const g = candidate as Record<string, unknown>;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;
  return candidate as CausalGraph;
}
