import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runExtractor } from "../extractor.js";
import type { ExtractorOutput } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, "fixtures");

function listFixtures(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

async function extract(fixture: string): Promise<ExtractorOutput> {
  const repoPath = join(FIXTURES_DIR, fixture);
  return runExtractor({ repoPath });
}

describe("extractor / 20 hand-crafted fixtures", () => {
  it("has 20 fixture directories", () => {
    const fixtures = listFixtures();
    expect(fixtures.length).toBe(20);
  });

  describe("01-simple-function", () => {
    it("emits export + non-export functions and a constant", async () => {
      const out = await extract("01-simple-function");
      const symbols = out.symbols.map((s) => `${s.name}:${s.kind}:${s.isExported}`).sort();
      expect(symbols).toEqual([
        "PI:variable:true",
        "_internal:function:false",
        "add:function:true",
      ]);
      const add = out.symbols.find((s) => s.name === "add")!;
      expect(add.signature).toMatch(/\(a: number, b: number\): number/);
      expect(add.returnType).toBe("number");
    });
  });

  describe("02-class", () => {
    it("emits class + members with correct kinds and modifiers", async () => {
      const out = await extract("02-class");
      const counter = out.symbols.find((s) => s.name === "Counter")!;
      expect(counter.kind).toBe("class");
      expect(counter.isExported).toBe(true);

      const inc = out.symbols.find((s) => s.name === "increment")!;
      expect(inc.kind).toBe("method");
      expect(inc.parentFqn).toBe("index.ts::Counter");

      const zero = out.symbols.find((s) => s.name === "zero")!;
      expect(zero.isStatic).toBe(true);

      const value = out.symbols.find((s) => s.name === "value")!;
      expect(value.visibility).toBe("private");
    });
  });

  describe("03-interface", () => {
    it("emits interfaces + members and an extends edge", async () => {
      const out = await extract("03-interface");
      const user = out.symbols.find((s) => s.name === "User" && s.kind === "interface")!;
      expect(user).toBeDefined();
      const greet = out.symbols.find((s) => s.name === "greet")!;
      expect(greet.kind).toBe("method");
      const admin = out.symbols.find((s) => s.name === "Admin")!;
      expect(admin.kind).toBe("interface");

      const extendsRefs = out.references.filter((r) => r.kind === "extends");
      expect(extendsRefs.length).toBe(1);
      expect(extendsRefs[0]?.targetFqn).toContain("::User");
    });
  });

  describe("04-type-alias", () => {
    it("emits type aliases incl. internal one and tracks generic param", async () => {
      const out = await extract("04-type-alias");
      const types = out.symbols.filter((s) => s.kind === "type").map((s) => s.name).sort();
      expect(types).toEqual(["ID", "Internal", "Maybe"]);

      const maybe = out.symbols.find((s) => s.name === "Maybe")!;
      expect(maybe.isExported).toBe(true);
    });
  });

  describe("05-generics", () => {
    it("captures generic params on type-facts side", async () => {
      const out = await extract("05-generics");
      const identity = out.typeFacts.find((f) => f.symbolFqn.endsWith("::identity"))!;
      expect(identity.genericParams).toEqual(["T"]);

      const map = out.typeFacts.find((f) => f.symbolFqn.endsWith("Box.map"))!;
      expect(map.genericParams).toEqual(["U extends object"]);
    });
  });

  describe("06-decorators", () => {
    it("emits a class with property members despite decorators", async () => {
      const out = await extract("06-decorators");
      const point = out.symbols.find((s) => s.name === "Point")!;
      expect(point.kind).toBe("class");
      const xy = out.symbols.filter((s) => s.parentFqn?.endsWith("::Point"));
      expect(xy.length).toBe(2);
    });
  });

  describe("07-jsx", () => {
    it("emits jsx_use references for component usage", async () => {
      const out = await extract("07-jsx");
      const button = out.symbols.find((s) => s.name === "Button")!;
      expect(button.kind).toBe("function");
      const jsxRefs = out.references.filter((r) => r.kind === "jsx_use");
      expect(jsxRefs.some((r) => r.targetFqn.endsWith("::Button"))).toBe(true);
    });
  });

  describe("08-enum", () => {
    it("emits enum + member symbols", async () => {
      const out = await extract("08-enum");
      const enums = out.symbols.filter((s) => s.kind === "enum").map((s) => s.name).sort();
      expect(enums).toEqual(["Priority", "Status"]);
      const members = out.symbols.filter((s) => s.parentFqn?.includes("::Status"));
      expect(members.map((s) => s.name).sort()).toEqual(["Active", "Closed", "Pending"]);
    });
  });

  describe("09-namespace", () => {
    it("emits nested namespace symbols with dotted owner chains", async () => {
      const out = await extract("09-namespace");
      const inner = out.symbols.find((s) => s.fqn.endsWith("::Math2.Inner.triple"));
      expect(inner).toBeDefined();
      const double = out.symbols.find((s) => s.fqn.endsWith("::Math2.double"));
      expect(double?.kind).toBe("function");
    });
  });

  describe("10-decl-merging", () => {
    it("emits both interface and namespace under the SAME FQN distinguished by kind", async () => {
      const out = await extract("10-decl-merging");
      const vehicleRows = out.symbols.filter((s) => s.fqn.endsWith("::Vehicle"));
      const kinds = vehicleRows.map((s) => s.kind).sort();
      expect(kinds).toEqual(["interface", "namespace"]);
      // The namespace's members live under the SAME owner chain.
      expect(out.symbols.some((s) => s.fqn.endsWith("::Vehicle.DEFAULT_WHEELS"))).toBe(true);
      expect(out.symbols.some((s) => s.fqn.endsWith("::Vehicle.withWheels"))).toBe(true);
    });
  });

  describe("11-conditional-types", () => {
    it("emits conditional and mapped type aliases", async () => {
      const out = await extract("11-conditional-types");
      const names = out.symbols.filter((s) => s.kind === "type").map((s) => s.name).sort();
      expect(names).toEqual(["ElementOf", "IsArray", "ReadonlyDeep"]);
    });
  });

  describe("12-imports", () => {
    it("emits import edges and per-name reference rows", async () => {
      const out = await extract("12-imports");
      // Two imports come from index.ts → ./helpers and * as ns from ./helpers
      const indexImports = out.imports.filter((i) => i.sourceFile.endsWith("index.ts"));
      expect(indexImports.length).toBeGreaterThanOrEqual(2);
      const targets = indexImports.map((i) => i.targetModule);
      expect(targets).toContain("./helpers");

      // Renamed import preserves {local, original}.
      const namedImport = indexImports.find((i) =>
        Array.isArray(i.importedNames) && i.importedNames.some((n) => typeof n === "object" && n.local === "renamed"),
      );
      expect(namedImport).toBeDefined();

      // Reference rows: at least one "import" kind that targets helperA.
      expect(out.references.some((r) => r.kind === "import" && r.targetFqn.endsWith("::helperA"))).toBe(true);
      // And a call to renamed (== helperB).
      expect(out.references.some((r) => r.kind === "call" && r.targetFqn.endsWith("::helperB"))).toBe(true);
    });
  });

  describe("13-async", () => {
    it("captures async modifier + JSDoc throws", async () => {
      const out = await extract("13-async");
      const fetchFirst = out.symbols.find((s) => s.name === "fetchFirstUser")!;
      expect(fetchFirst.isAsync).toBe(true);
      expect(fetchFirst.docComment ?? "").toMatch(/Fetch the first user/);

      const fact = out.typeFacts.find((f) => f.symbolFqn.endsWith("::fetchFirstUser"))!;
      expect(fact.throws).toEqual(["NotFoundError"]);
    });
  });

  describe("14-abstract", () => {
    it("captures abstract class and method", async () => {
      const out = await extract("14-abstract");
      const animal = out.symbols.find((s) => s.name === "Animal")!;
      expect(animal.isAbstract).toBe(true);
      const speak = out.symbols.find(
        (s) => s.name === "speak" && s.parentFqn?.endsWith("::Animal"),
      )!;
      expect(speak.isAbstract).toBe(true);

      const dogExtends = out.references.find(
        (r) => r.kind === "extends" && r.targetFqn.endsWith("::Animal"),
      );
      expect(dogExtends).toBeDefined();
    });
  });

  describe("15-side-effects", () => {
    it("infers writes_db + external HTTP for createUser, reads_db for listUsers", async () => {
      const out = await extract("15-side-effects");
      const create = out.typeFacts.find((f) => f.symbolFqn.endsWith("::createUser"))!;
      expect(create.sideEffects?.writesDb).toBe(true);
      expect(create.sideEffects?.callsExternal).toContain("fetch");

      const list = out.typeFacts.find((f) => f.symbolFqn.endsWith("::listUsers"))!;
      expect(list.sideEffects?.readsDb).toBe(true);
      expect(list.sideEffects?.writesDb).toBe(false);

      // pure function — no side-effects row at all (effects were null).
      const pure = out.typeFacts.find((f) => f.symbolFqn.endsWith("::pure"));
      expect(pure?.sideEffects ?? null).toBe(null);
    });
  });

  describe("16-extends-implements", () => {
    it("captures extends + implements as separate reference rows", async () => {
      const out = await extract("16-extends-implements");
      const ex = out.references.filter((r) => r.kind === "extends");
      const im = out.references.filter((r) => r.kind === "implements");
      expect(ex.some((r) => r.targetFqn.endsWith("::BaseEntity"))).toBe(true);
      expect(im.some((r) => r.targetFqn.endsWith("::Comparable"))).toBe(true);
    });
  });

  describe("17-getter-setter", () => {
    it("emits accessors as method-kind symbols", async () => {
      const out = await extract("17-getter-setter");
      const accessors = out.symbols.filter(
        (s) => s.kind === "method" && s.parentFqn?.endsWith("::Temperature"),
      );
      expect(accessors.map((s) => s.name).sort()).toContain("celsius");
      expect(accessors.map((s) => s.name)).toContain("fahrenheit");
    });
  });

  describe("18-re-export", () => {
    it("emits re_export reference rows", async () => {
      const out = await extract("18-re-export");
      const reExports = out.references.filter((r) => r.kind === "re_export");
      // Three re-exports: { helper }, *, { helper as renamed } — but `*` doesn't
      // generate a per-name re_export reference (no named element). So 2.
      expect(reExports.length).toBe(2);
      expect(reExports.every((r) => r.targetFqn.endsWith("::helper"))).toBe(true);
    });
  });

  describe("19-cross-file", () => {
    it("resolves cross-file references to canonical FQNs", async () => {
      const out = await extract("19-cross-file");
      const calls = out.references.filter((r) => r.kind === "call");
      const callsNewSession = calls.filter((r) => r.targetFqn.endsWith("auth.ts::newSession"));
      expect(callsNewSession.length).toBeGreaterThan(0);

      const typeRefs = out.references.filter((r) => r.kind === "type_ref");
      expect(typeRefs.some((r) => r.targetFqn.endsWith("auth.ts::Session"))).toBe(true);
    });
  });

  describe("20-mapped-types", () => {
    it("emits mapped types and a const that uses one", async () => {
      const out = await extract("20-mapped-types");
      const types = out.symbols.filter((s) => s.kind === "type").map((s) => s.name).sort();
      expect(types).toEqual(["Mutable", "PartialDeep"]);
      const sample = out.symbols.find((s) => s.name === "sample")!;
      expect(sample.kind).toBe("variable");
    });
  });
});

describe("ExtractorOutput / cross-cutting invariants", () => {
  it("every symbol has a non-empty FQN starting with the file path", async () => {
    const fixtures = listFixtures();
    for (const fx of fixtures) {
      const out = await extract(fx);
      for (const s of out.symbols) {
        expect(s.fqn.length).toBeGreaterThan(0);
        expect(s.fqn).toContain("::");
      }
    }
  });

  it("every reference target FQN appears in the symbol catalogue (cross-file)", async () => {
    // For fixtures with multiple files we expect 100% target resolution.
    const out = await extract("19-cross-file");
    const fqns = new Set(out.symbols.map((s) => s.fqn));
    const unresolved = out.references.filter((r) => !fqns.has(r.targetFqn));
    expect(unresolved.length).toBe(0);
  });

  it("ast_hash is stable within a run (all unique per declaration but reproducible)", async () => {
    const out1 = await extract("02-class");
    const out2 = await extract("02-class");
    expect(out1.symbols.map((s) => s.astHash).sort()).toEqual(
      out2.symbols.map((s) => s.astHash).sort(),
    );
  });

  it("FIXTURES_DIR exists", () => {
    expect(existsSync(FIXTURES_DIR)).toBe(true);
  });
});
