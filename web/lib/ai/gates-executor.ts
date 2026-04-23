/**
 * Auto-merge gates DAG executor (Fase 8).
 *
 * Takes a set of producer specs (see `gates-producers.ts`) with explicit
 * `dependsOn` edges, topologically sorts them into levels (Kahn's
 * algorithm), and runs each level under `Promise.all` when
 * `GATES_PARALLEL=true`, or serially when the flag is off.
 *
 * The executor is deliberately generic: it doesn't know about the 17 gates.
 * The knowledge of which producers to run lives in the caller
 * (`remediate.ts`), which assembles a DAG around the local state it needs
 * (aiKey, session, fix.files, ...).
 *
 * Design rules:
 *   1. Audit-trail integrity — if a producer throws, we never cancel its
 *      siblings. The error is captured per-producer and the executor
 *      finishes the level before propagating.
 *   2. Cross-level early-abort is the caller's responsibility. This
 *      executor only gives you the level/topology primitive; the caller
 *      inspects outputs and decides whether to kick off the next DAG.
 *   3. Rollback via flag — `GATES_PARALLEL=false` runs the producers in
 *      the order the caller passed them (insertion order), preserving
 *      pre-Fase-8 behavior exactly.
 *
 * See `web/docs/gates-dependency.md` for the full gate DAG.
 */

import type { ProducerSpec } from "./gates-producers";
import { isGatesParallelEnabled } from "./gates-producers";

/** Outcome of a single producer. `error` is populated when `run()` threw. */
export type ProducerResult<T> = {
  name: string;
  level: number;
  value: T | null;
  error: Error | null;
  durationMs: number;
};

/** Full executor output: results keyed by producer name + level grouping + timing. */
export type DagResult = {
  results: Record<string, ProducerResult<unknown>>;
  levels: string[][];
  totalDurationMs: number;
  mode: "parallel" | "serial";
};

/**
 * Group producers into levels via Kahn's topological sort.
 *
 * Level 0 = producers with no deps.
 * Level N = producers whose deps are all resolved at level < N.
 *
 * Dependencies that point to names NOT in `specs` are treated as "external"
 * (e.g. "ci_passed" when the DAG is a pre-push DAG) — they don't push a
 * producer to a later level. This lets callers compose partial DAGs.
 *
 * Throws on cycles.
 */
export function toposortLevels(specs: readonly ProducerSpec<unknown>[]): string[][] {
  const names = new Set(specs.map((s) => s.name));
  const indeg = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const s of specs) {
    const internalDeps = s.dependsOn.filter((d) => names.has(d));
    indeg.set(s.name, internalDeps.length);
    for (const d of internalDeps) {
      if (!children.has(d)) children.set(d, []);
      children.get(d)!.push(s.name);
    }
  }

  const levels: string[][] = [];
  let frontier = specs.filter((s) => (indeg.get(s.name) ?? 0) === 0).map((s) => s.name);

  while (frontier.length > 0) {
    // Preserve caller insertion order within a level for deterministic serial mode.
    const orderedFrontier = specs
      .filter((s) => frontier.includes(s.name))
      .map((s) => s.name);
    levels.push(orderedFrontier);

    const next: string[] = [];
    for (const n of orderedFrontier) {
      for (const c of children.get(n) ?? []) {
        const remaining = (indeg.get(c) ?? 0) - 1;
        indeg.set(c, remaining);
        if (remaining === 0) next.push(c);
      }
    }
    frontier = next;
  }

  const placed = new Set(levels.flat());
  if (placed.size !== specs.length) {
    const missing = specs.map((s) => s.name).filter((n) => !placed.has(n));
    throw new Error(`gates-executor: cycle detected — unresolved producers: ${missing.join(", ")}`);
  }

  return levels;
}

/**
 * Run a producer DAG. In parallel mode (default when GATES_PARALLEL=true),
 * producers within a level run under `Promise.all`. In serial mode, they
 * run sequentially in caller insertion order — equivalent to pre-Fase-8.
 *
 * The second parameter accepts an explicit `parallel` override. Used by
 * tests to exercise both modes without mutating process.env.
 */
export async function runGateDag(
  specs: readonly ProducerSpec<unknown>[],
  opts: { parallel?: boolean } = {},
): Promise<DagResult> {
  const parallel = opts.parallel ?? isGatesParallelEnabled();
  const levels = toposortLevels(specs);
  const byName = new Map(specs.map((s) => [s.name, s] as const));
  const results: Record<string, ProducerResult<unknown>> = {};
  const start = Date.now();

  async function runOne(name: string, level: number): Promise<void> {
    const spec = byName.get(name)!;
    const t0 = Date.now();
    try {
      const value = await spec.run();
      results[name] = { name, level, value, error: null, durationMs: Date.now() - t0 };
    } catch (err) {
      results[name] = {
        name,
        level,
        value: null,
        error: err instanceof Error ? err : new Error(String(err)),
        durationMs: Date.now() - t0,
      };
    }
  }

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (parallel) {
      await Promise.all(level.map((n) => runOne(n, i)));
    } else {
      for (const n of level) await runOne(n, i);
    }
  }

  return {
    results,
    levels,
    totalDurationMs: Date.now() - start,
    mode: parallel ? "parallel" : "serial",
  };
}

/** Typed helper: pull a producer's value out of a DagResult with the right shape. */
export function dagValue<T>(dag: DagResult, name: string): T | null {
  const r = dag.results[name];
  return (r?.value as T | undefined) ?? null;
}
