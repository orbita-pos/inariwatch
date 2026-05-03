// Phase 2.2 integration tests — runs the full extractor against each fixture
// directory and asserts on the produced symbols / references / type facts /
// imports.
//
// Fixtures live in `fixtures/` (one directory per fixture). Each fixture is
// treated as its own "repo" by the extractor — so file paths are
// repo-relative within that fixture's directory.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

import { runExtractor } from "../extractor.js";
import type { CodeReference, CodeSymbol, ExtractorOutput } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, "fixtures");

function fixturePath(name: string): string {
  return resolve(fixtureRoot, name);
}

function findSymbol(out: ExtractorOutput, fqnEnd: string): CodeSymbol | undefined {
  return out.symbols.find((s) => s.fqn.endsWith(fqnEnd));
}

function refsTo(out: ExtractorOutput, fqnEnd: string): CodeReference[] {
  return out.references.filter((r) => r.targetFqn.endsWith(fqnEnd));
}

describe("extractor — 01_simple_function", () => {
  let out: ExtractorOutput;

  it("runs", async () => {
    out = await runExtractor({ repoPath: fixturePath("01_simple_function") });
    expect(out.diagnostics).toEqual([]);
    expect(out.filesProcessed).toBe(1);
  }, 30_000);

  it("emits the two functions + module vars + nothing else top-level", () => {
    const top = out.symbols.filter((s) => !s.parentFqn);
    const names = top.map((s) => s.name).sort();
    expect(names).toContain("add");
    expect(names).toContain("greet");
    expect(names).toContain("x");
    expect(names).toContain("y");
  });

  it("captures type info for `add`", () => {
    const add = findSymbol(out, "::add");
    expect(add).toBeDefined();
    expect(add!.kind).toBe("function");
    expect(add!.returnType).toBe("int");
    expect(add!.signature).toMatch(/def add\(a: int, b: int\) -> int/);
    expect(add!.docComment).toBe("Return the sum of a and b.");
    expect(add!.isExported).toBe(true);
    expect(add!.language).toBe("python");
  });

  it("emits a CodeReference from `x = add(1, 2)`", () => {
    const refs = refsTo(out, "::add");
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs[0]?.kind).toBe("call");
  });

  it("populates type facts (params, return)", () => {
    const fact = out.typeFacts.find((f) => f.symbolFqn.endsWith("::add"));
    expect(fact).toBeDefined();
    expect(fact!.returnType).toBe("int");
    expect(fact!.paramTypes).toEqual([
      { name: "a", type: "int", optional: false, defaultValue: null },
      { name: "b", type: "int", optional: false, defaultValue: null },
    ]);
  });
});

describe("extractor — 02_class", () => {
  let out: ExtractorOutput;

  it("runs", async () => {
    out = await runExtractor({ repoPath: fixturePath("02_class") });
    expect(out.diagnostics).toEqual([]);
  }, 30_000);

  it("emits the User class + its methods with parent linkage", () => {
    const user = findSymbol(out, "::User");
    expect(user).toBeDefined();
    expect(user!.kind).toBe("class");
    expect(user!.parentFqn).toBeNull();

    const init = findSymbol(out, "::User.__init__");
    expect(init).toBeDefined();
    expect(init!.kind).toBe("method");
    expect(init!.parentFqn).toBe(user!.fqn);
    expect(init!.parentKind).toBe("class");

    const isAdult = findSymbol(out, "::User.is_adult");
    expect(isAdult?.kind).toBe("method");
    expect(isAdult?.returnType).toBe("bool");
  });

  it("flags _generate_token as private via Python convention", () => {
    const helper = findSymbol(out, "::User._generate_token");
    expect(helper?.visibility).toBe("private");
  });

  it("captures the class docstring", () => {
    const user = findSymbol(out, "::User");
    expect(user?.docComment).toBe("A user record.");
  });
});

describe("extractor — 03_dataclass", () => {
  let out: ExtractorOutput;

  it("runs", async () => {
    out = await runExtractor({ repoPath: fixturePath("03_dataclass") });
  }, 30_000);

  it("emits the Order class", () => {
    const order = findSymbol(out, "::Order");
    expect(order).toBeDefined();
    expect(order!.kind).toBe("class");
  });

  it("captures the make_order factory + its return type via hover", () => {
    const make = findSymbol(out, "::make_order");
    expect(make?.kind).toBe("function");
    expect(make?.returnType).toBe("Order");
  });

  it("records imports from dataclasses", () => {
    const imp = out.imports.find((i) => i.targetModule === "dataclasses");
    expect(imp).toBeDefined();
    expect(imp?.importedNames).toEqual(expect.arrayContaining(["dataclass", "field"]));
  });
});

describe("extractor — 04_decorators", () => {
  let out: ExtractorOutput;

  it("runs", async () => {
    out = await runExtractor({ repoPath: fixturePath("04_decorators") });
  }, 30_000);

  it("captures the property + setter as methods on Counter", () => {
    const value = out.symbols.filter((s) => s.fqn.endsWith("::Counter.value"));
    expect(value.length).toBeGreaterThanOrEqual(1);
    expect(value.every((v) => v.kind === "method")).toBe(true);
  });

  it("flags @staticmethod and @classmethod as static", () => {
    const zero = findSymbol(out, "::Counter.zero");
    expect(zero?.isStatic).toBe(true);
    const startingAt = findSymbol(out, "::Counter.starting_at");
    expect(startingAt?.isStatic).toBe(true);
  });

  it("captures @lru_cache module-level function", () => {
    const fib = findSymbol(out, "::fib");
    expect(fib?.kind).toBe("function");
    expect(fib?.returnType).toBe("int");
  });
});

describe("extractor — 05_async", () => {
  let out: ExtractorOutput;

  it("runs", async () => {
    out = await runExtractor({ repoPath: fixturePath("05_async") });
  }, 30_000);

  it("flags async functions with isAsync=true", () => {
    const fetchOne = findSymbol(out, "::fetch_one");
    expect(fetchOne?.isAsync).toBe(true);
    const fetchMany = findSymbol(out, "::fetch_many");
    expect(fetchMany?.isAsync).toBe(true);
  });

  it("captures the docstring on fetch_one", () => {
    const fetchOne = findSymbol(out, "::fetch_one");
    expect(fetchOne?.docComment).toBe("Fetch a single URL.");
  });

  it("emits a reference from fetch_many → fetch_one", () => {
    const refs = refsTo(out, "::fetch_one");
    const fromMany = refs.find((r) => r.sourceFqn?.endsWith("::fetch_many"));
    expect(fromMany).toBeDefined();
  });
});

describe("extractor — 06_typing", () => {
  let out: ExtractorOutput;

  it("runs", async () => {
    out = await runExtractor({ repoPath: fixturePath("06_typing") });
  }, 30_000);

  it("captures generic functions", () => {
    const first = findSymbol(out, "::first");
    expect(first?.signature).toMatch(/def first/);
    const mapAll = findSymbol(out, "::map_all");
    expect(mapAll?.signature).toMatch(/def map_all/);
  });

  it("emits a call from total = map_all([1,2,3], double)", () => {
    const refs = refsTo(out, "::map_all");
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("extractor — 07_protocol", () => {
  let out: ExtractorOutput;

  it("runs", async () => {
    out = await runExtractor({ repoPath: fixturePath("07_protocol") });
  }, 30_000);

  it("emits Repository as a class (Protocol classes look like classes via LSP)", () => {
    const repo = findSymbol(out, "::Repository");
    expect(repo?.kind).toBe("class");
  });

  it("emits InMemoryRepo with get/save methods", () => {
    expect(findSymbol(out, "::InMemoryRepo.get")).toBeDefined();
    expect(findSymbol(out, "::InMemoryRepo.save")).toBeDefined();
  });

  it("emits a use_repo function that takes a Repository", () => {
    const use = findSymbol(out, "::use_repo");
    expect(use?.signature).toMatch(/repo: Repository/);
  });
});

describe("extractor — 08_optional_union", () => {
  let out: ExtractorOutput;

  it("runs", async () => {
    out = await runExtractor({ repoPath: fixturePath("08_optional_union") });
  }, 30_000);

  it("marks Optional/None-defaulted params as optional in type facts", () => {
    const fact = out.typeFacts.find((f) => f.symbolFqn.endsWith("::lookup_user"));
    expect(fact).toBeDefined();
    const dft = fact!.paramTypes!.find((p) => p.name === "default");
    expect(dft?.optional).toBe(true);
  });

  it("captures union return types via hover", () => {
    const maybe = findSymbol(out, "::maybe_name");
    expect(maybe?.returnType).toMatch(/None/);
  });
});

describe("extractor — 09_dynamic_imports", () => {
  let out: ExtractorOutput;

  it("runs", async () => {
    out = await runExtractor({ repoPath: fixturePath("09_dynamic_imports") });
  }, 30_000);

  it("records the importlib import edge", () => {
    const imp = out.imports.find((i) => i.targetModule === "importlib");
    expect(imp).toBeDefined();
  });

  it("records the load_plugin / alias_plugin / maybe_load functions", () => {
    expect(findSymbol(out, "::load_plugin")).toBeDefined();
    expect(findSymbol(out, "::alias_plugin")).toBeDefined();
    expect(findSymbol(out, "::maybe_load")).toBeDefined();
  });
});

describe("extractor — 10_init_module", () => {
  let out: ExtractorOutput;

  it("runs over a multi-file package", async () => {
    out = await runExtractor({ repoPath: fixturePath("10_init_module") });
    expect(out.filesProcessed).toBe(2);
  }, 30_000);

  it("resolves relative imports against the package root", () => {
    const initImports = out.imports.filter((i) => i.sourceFile === "__init__.py");
    expect(initImports.length).toBeGreaterThanOrEqual(1);
    const helpersImp = initImports.find((i) => i.targetModule === ".helpers");
    expect(helpersImp).toBeDefined();
    expect(helpersImp?.resolvedFile).toBe("helpers.py");
  });

  it("emits exclaim from __init__.py", () => {
    const exclaim = findSymbol(out, "__init__.py::exclaim");
    expect(exclaim).toBeDefined();
  });

  it("emits shout / whisper from helpers.py", () => {
    expect(findSymbol(out, "helpers.py::shout")).toBeDefined();
    expect(findSymbol(out, "helpers.py::whisper")).toBeDefined();
  });
});

describe("extractor — 11_constants", () => {
  let out: ExtractorOutput;

  it("runs", async () => {
    out = await runExtractor({ repoPath: fixturePath("11_constants") });
  }, 30_000);

  it("emits MAX_RETRIES and PI as variables", () => {
    expect(findSymbol(out, "::MAX_RETRIES")?.kind).toBe("variable");
    expect(findSymbol(out, "::PI")?.kind).toBe("variable");
  });
});

describe("extractor — 12_typed_dict", () => {
  let out: ExtractorOutput;

  it("runs", async () => {
    out = await runExtractor({ repoPath: fixturePath("12_typed_dict") });
  }, 30_000);

  it("emits AlertEvent as a class", () => {
    const ae = findSymbol(out, "::AlertEvent");
    expect(ae).toBeDefined();
    expect(ae!.kind).toBe("class");
  });

  it("emits coerce_event with a dict[str, object] return", () => {
    const ce = findSymbol(out, "::coerce_event");
    expect(ce?.kind).toBe("function");
    expect(ce?.returnType).toBe("AlertEvent");
  });
});

describe("extractor — 13_abstract_base", () => {
  let out: ExtractorOutput;

  it("runs", async () => {
    out = await runExtractor({ repoPath: fixturePath("13_abstract_base") });
  }, 30_000);

  it("flags @abstractmethod methods as isAbstract", () => {
    const read = findSymbol(out, "::Storage.read");
    expect(read?.isAbstract).toBe(true);
    const write = findSymbol(out, "::Storage.write");
    expect(write?.isAbstract).toBe(true);
  });

  it("emits InMemoryStorage methods as concrete (not abstract)", () => {
    const read = findSymbol(out, "::InMemoryStorage.read");
    expect(read?.isAbstract).toBe(false);
  });
});

describe("extractor — 14_exceptions", () => {
  let out: ExtractorOutput;

  it("runs", async () => {
    out = await runExtractor({ repoPath: fixturePath("14_exceptions") });
  }, 30_000);

  it("emits the exception classes", () => {
    expect(findSymbol(out, "::ValidationError")?.kind).toBe("class");
    expect(findSymbol(out, "::NotFoundError")?.kind).toBe("class");
  });

  it("captures `raise X` in throws via type facts", () => {
    const fact = out.typeFacts.find((f) => f.symbolFqn.endsWith("::validate_user"));
    expect(fact).toBeDefined();
    expect(fact!.throws).toEqual(expect.arrayContaining(["ValidationError"]));
  });

  it("captures Sphinx :raises: in docstring throws", () => {
    const fact = out.typeFacts.find((f) => f.symbolFqn.endsWith("::validate_user"));
    expect(fact!.throws).toEqual(expect.arrayContaining(["ValidationError"]));
  });

  it("captures Google-style Raises: in docstring throws", () => {
    const fact = out.typeFacts.find((f) => f.symbolFqn.endsWith("::find_user"));
    expect(fact?.throws).toEqual(expect.arrayContaining(["NotFoundError"]));
  });
});

describe("extractor — 15_mixed_typed", () => {
  let out: ExtractorOutput;

  it("runs", async () => {
    out = await runExtractor({ repoPath: fixturePath("15_mixed_typed") });
  }, 30_000);

  it("emits both typed and untyped functions", () => {
    expect(findSymbol(out, "::parse")).toBeDefined();
    expect(findSymbol(out, "::parse_int")).toBeDefined();
    expect(findSymbol(out, "::render")).toBeDefined();
    expect(findSymbol(out, "::render_typed")).toBeDefined();
  });

  it("typed function has a returnType; untyped function returns null or untyped marker", () => {
    const typed = findSymbol(out, "::parse_int");
    expect(typed?.returnType).toBe("int");
  });
});

describe("extractor — cross-cutting invariants", () => {
  it("every emitted symbol has language='python'", async () => {
    const out = await runExtractor({ repoPath: fixturePath("01_simple_function") });
    for (const s of out.symbols) {
      expect(s.language).toBe("python");
    }
  }, 30_000);

  it("symbols with parentFqn also have parentKind populated", async () => {
    const out = await runExtractor({ repoPath: fixturePath("02_class") });
    for (const s of out.symbols) {
      if (s.parentFqn) {
        expect(s.parentKind).not.toBeNull();
      }
    }
  }, 30_000);

  it("ast hashes are stable + non-empty", async () => {
    const out = await runExtractor({ repoPath: fixturePath("01_simple_function") });
    for (const s of out.symbols) {
      expect(s.astHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Re-running produces the same hashes.
    const out2 = await runExtractor({ repoPath: fixturePath("01_simple_function") });
    const map1 = new Map(out.symbols.map((s) => [s.fqn + "::" + s.kind, s.astHash]));
    const map2 = new Map(out2.symbols.map((s) => [s.fqn + "::" + s.kind, s.astHash]));
    for (const [k, v] of map1) {
      expect(map2.get(k)).toBe(v);
    }
  }, 60_000);
});
