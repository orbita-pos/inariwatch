import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runGateDag, toposortLevels, dagValue } from "../gates-executor";
import type { ProducerSpec } from "../gates-producers";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A producer that resolves after `ms` with the given value. */
function delayed<T>(name: string, ms: number, value: T, deps: string[] = []): ProducerSpec<unknown> {
  return {
    name,
    dependsOn: deps,
    run: async () => {
      await new Promise((r) => setTimeout(r, ms));
      return value;
    },
  };
}

/** A producer that throws after `ms`. */
function throwing(name: string, ms: number, err: string, deps: string[] = []): ProducerSpec<unknown> {
  return {
    name,
    dependsOn: deps,
    run: async () => {
      await new Promise((r) => setTimeout(r, ms));
      throw new Error(err);
    },
  };
}

// ── Toposort ────────────────────────────────────────────────────────────────

describe("toposortLevels", () => {
  it("groups independent producers into a single level", () => {
    const levels = toposortLevels([
      { name: "a", dependsOn: [], run: async () => 1 },
      { name: "b", dependsOn: [], run: async () => 2 },
      { name: "c", dependsOn: [], run: async () => 3 },
    ]);
    expect(levels).toEqual([["a", "b", "c"]]);
  });

  it("places dependents on later levels", () => {
    const levels = toposortLevels([
      { name: "a", dependsOn: [], run: async () => 1 },
      { name: "b", dependsOn: ["a"], run: async () => 2 },
      { name: "c", dependsOn: ["b"], run: async () => 3 },
    ]);
    expect(levels).toEqual([["a"], ["b"], ["c"]]);
  });

  it("fans in: one level N depends on multiple level N-1", () => {
    const levels = toposortLevels([
      { name: "a", dependsOn: [], run: async () => 1 },
      { name: "b", dependsOn: [], run: async () => 2 },
      { name: "c", dependsOn: ["a", "b"], run: async () => 3 },
    ]);
    expect(levels).toEqual([["a", "b"], ["c"]]);
  });

  it("preserves caller insertion order within a level", () => {
    const levels = toposortLevels([
      { name: "z", dependsOn: [], run: async () => 1 },
      { name: "a", dependsOn: [], run: async () => 2 },
      { name: "m", dependsOn: [], run: async () => 3 },
    ]);
    // Insertion order: z, a, m — not alphabetical.
    expect(levels).toEqual([["z", "a", "m"]]);
  });

  it("ignores external deps (names not in the DAG)", () => {
    const levels = toposortLevels([
      { name: "a", dependsOn: ["ci_passed"], run: async () => 1 }, // ci_passed is external
    ]);
    expect(levels).toEqual([["a"]]);
  });

  it("throws on cycles", () => {
    expect(() => toposortLevels([
      { name: "a", dependsOn: ["b"], run: async () => 1 },
      { name: "b", dependsOn: ["a"], run: async () => 2 },
    ])).toThrow(/cycle detected/);
  });

  it("empty DAG yields no levels", () => {
    expect(toposortLevels([])).toEqual([]);
  });
});

// ── Parallel vs serial wall time ────────────────────────────────────────────

describe("runGateDag execution mode", () => {
  beforeEach(() => {
    vi.useRealTimers(); // we need real wall clock for the timing assertions
  });

  it("parallel: two 100ms producers finish in ~100ms (max), not 200ms (sum)", async () => {
    const t0 = Date.now();
    const dag = await runGateDag(
      [delayed("a", 100, 1), delayed("b", 100, 2)],
      { parallel: true },
    );
    const elapsed = Date.now() - t0;
    expect(dag.mode).toBe("parallel");
    expect(dag.results["a"].value).toBe(1);
    expect(dag.results["b"].value).toBe(2);
    // Parallel bound: max(a, b) + small overhead. Give 150ms headroom for CI.
    expect(elapsed).toBeLessThan(250);
    // And clearly NOT the serial sum (~200ms).
    expect(elapsed).toBeLessThan(195);
  });

  it("serial: two 100ms producers finish in ~200ms (sum)", async () => {
    const t0 = Date.now();
    const dag = await runGateDag(
      [delayed("a", 100, 1), delayed("b", 100, 2)],
      { parallel: false },
    );
    const elapsed = Date.now() - t0;
    expect(dag.mode).toBe("serial");
    // Serial: a (100ms) then b (100ms) ~ 200ms. Floor at 180 to allow scheduler jitter.
    expect(elapsed).toBeGreaterThanOrEqual(180);
  });

  it("respects GATES_PARALLEL env var when no explicit override", async () => {
    const prev = process.env.GATES_PARALLEL;
    try {
      process.env.GATES_PARALLEL = "true";
      const dag1 = await runGateDag([delayed("a", 10, 1)]);
      expect(dag1.mode).toBe("parallel");

      process.env.GATES_PARALLEL = "false";
      const dag2 = await runGateDag([delayed("a", 10, 1)]);
      expect(dag2.mode).toBe("serial");

      delete process.env.GATES_PARALLEL;
      const dag3 = await runGateDag([delayed("a", 10, 1)]);
      expect(dag3.mode).toBe("serial"); // default off
    } finally {
      if (prev === undefined) delete process.env.GATES_PARALLEL;
      else process.env.GATES_PARALLEL = prev;
    }
  });

  it("dependent producers run strictly after their deps in both modes", async () => {
    const order: string[] = [];
    const recordProducer = (name: string, deps: string[]): ProducerSpec<unknown> => ({
      name,
      dependsOn: deps,
      run: async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(name);
        return name;
      },
    });

    // a before b; b before c
    const specs = [
      recordProducer("a", []),
      recordProducer("b", ["a"]),
      recordProducer("c", ["b"]),
    ];

    await runGateDag(specs, { parallel: true });
    expect(order).toEqual(["a", "b", "c"]);

    order.length = 0;
    await runGateDag(specs, { parallel: false });
    expect(order).toEqual(["a", "b", "c"]);
  });
});

// ── Error isolation ─────────────────────────────────────────────────────────

describe("runGateDag error isolation", () => {
  it("a throwing producer never cancels its siblings in the same level", async () => {
    const dag = await runGateDag(
      [throwing("bad", 10, "boom"), delayed("good", 30, "ok")],
      { parallel: true },
    );
    expect(dag.results["bad"].error).toBeInstanceOf(Error);
    expect(dag.results["bad"].error?.message).toBe("boom");
    expect(dag.results["bad"].value).toBeNull();
    expect(dag.results["good"].error).toBeNull();
    expect(dag.results["good"].value).toBe("ok");
  });

  it("captures per-producer duration even on throw", async () => {
    const dag = await runGateDag(
      [throwing("bad", 20, "boom")],
      { parallel: true },
    );
    expect(dag.results["bad"].durationMs).toBeGreaterThanOrEqual(15);
  });

  it("a non-Error throw is wrapped in Error", async () => {
    const dag = await runGateDag(
      [{ name: "weird", dependsOn: [], run: async () => { throw "string-thrown" as unknown as Error; } }],
      { parallel: true },
    );
    expect(dag.results["weird"].error).toBeInstanceOf(Error);
    expect(dag.results["weird"].error?.message).toBe("string-thrown");
  });
});

// ── dagValue typed helper ───────────────────────────────────────────────────

describe("dagValue", () => {
  it("returns the typed value for a successful producer", async () => {
    const dag = await runGateDag([delayed("x", 5, 42)], { parallel: true });
    expect(dagValue<number>(dag, "x")).toBe(42);
  });

  it("returns null for a failed producer", async () => {
    const dag = await runGateDag([throwing("x", 5, "nope")], { parallel: true });
    expect(dagValue<number>(dag, "x")).toBeNull();
  });

  it("returns null for unknown producer name", async () => {
    const dag = await runGateDag([delayed("x", 5, 1)], { parallel: true });
    expect(dagValue<number>(dag, "does-not-exist")).toBeNull();
  });
});

// ── Level metadata ──────────────────────────────────────────────────────────

describe("runGateDag reports levels and mode", () => {
  it("levels array reflects topological groupings", async () => {
    const dag = await runGateDag([
      delayed("a", 5, 1),
      delayed("b", 5, 2),
      delayed("c", 5, 3, ["a", "b"]),
    ], { parallel: true });
    expect(dag.levels).toEqual([["a", "b"], ["c"]]);
  });

  it("totalDurationMs is >= the slowest level", async () => {
    const dag = await runGateDag([delayed("a", 50, 1)], { parallel: true });
    expect(dag.totalDurationMs).toBeGreaterThanOrEqual(40);
  });
});

// ── Empty DAG ───────────────────────────────────────────────────────────────

describe("runGateDag edge cases", () => {
  it("empty DAG is a no-op", async () => {
    const dag = await runGateDag([], { parallel: true });
    expect(dag.results).toEqual({});
    expect(dag.levels).toEqual([]);
  });

  it("single-producer DAG works in both modes", async () => {
    for (const parallel of [true, false]) {
      const dag = await runGateDag([delayed("only", 5, "hi")], { parallel });
      expect(dag.results["only"].value).toBe("hi");
      expect(dag.levels).toEqual([["only"]]);
    }
  });
});

// ── End-to-end: mimicking the pre-push cohort shape in remediate.ts ─────────

describe("runGateDag end-to-end: pre-push cohort shape", () => {
  it("parallelizes security_ai_review + self_review_cheap — wall time ~ max", async () => {
    const t0 = Date.now();
    const dag = await runGateDag([
      { name: "security_ai_review", dependsOn: [], run: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return [{ severity: "LOW", rule: "test", message: "m", file: "f", line: 1 }];
      }},
      { name: "self_review_cheap", dependsOn: [], run: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return JSON.stringify({ score: 85, recommendation: "approve", concerns: [] });
      }},
    ], { parallel: true });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(200); // not 240+ (sum)
    expect(dag.results["security_ai_review"].error).toBeNull();
    expect(dag.results["self_review_cheap"].error).toBeNull();
  });

  it("serial fallback runs ~sum", async () => {
    const t0 = Date.now();
    await runGateDag([
      { name: "a", dependsOn: [], run: async () => { await new Promise((r) => setTimeout(r, 80)); return 1; } },
      { name: "b", dependsOn: [], run: async () => { await new Promise((r) => setTimeout(r, 80)); return 2; } },
    ], { parallel: false });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });
});

// Clean up any leaked env var mutation
afterEach(() => {
  // no-op — specific tests that mutate env already clean up inside their own try/finally
});
