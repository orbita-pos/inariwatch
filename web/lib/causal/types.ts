/**
 * Server mirrors of the wire `CausalGraph` types — kept here so server
 * modules don't have to depend on the SDK package. Must stay byte-identical
 * to `capture/src/types.ts` (`CausalGraphNode`, `CausalGraphEdge`,
 * `CausalGraph`).
 */

export interface CausalGraphNode {
  id: string;
  kind: "io" | "fn" | "promise" | "syscall";
  label: string;
}

export interface CausalGraphEdge {
  from: string;
  to: string;
  kind: "causal" | "temporal" | "data";
}

export interface CausalGraph {
  nodes: CausalGraphNode[];
  edges: CausalGraphEdge[];
}
