// Pure parser tests for hover-parse.ts. No LSP. Fast.

import { describe, it, expect } from "vitest";

import { parseHoverText } from "../hover-parse.js";

describe("parseHoverText", () => {
  it("parses a multi-line function hover", () => {
    const out = parseHoverText("(function) def add(\n    a: int,\n    b: int\n) -> int");
    expect(out.kindWord).toBe("function");
    expect(out.isAsync).toBe(false);
    expect(out.returnType).toBe("int");
    expect(out.signature).toBe("def add(a: int, b: int) -> int");
    expect(out.paramTypes).toEqual([
      { name: "a", type: "int", optional: false, defaultValue: null },
      { name: "b", type: "int", optional: false, defaultValue: null },
    ]);
  });

  it("parses an async function", () => {
    const out = parseHoverText("(function) async def fetch(url: str) -> bytes");
    expect(out.isAsync).toBe(true);
    expect(out.returnType).toBe("bytes");
    expect(out.signature).toBe("async def fetch(url: str) -> bytes");
  });

  it("parses a method (with self stripped downstream)", () => {
    const out = parseHoverText("(method) def greet(self) -> str");
    expect(out.kindWord).toBe("method");
    expect(out.returnType).toBe("str");
    expect(out.paramTypes).toEqual([
      { name: "self", type: "Unknown", optional: false, defaultValue: null },
    ]);
  });

  it("captures default values + optional flag", () => {
    const out = parseHoverText("(function) def greet(name: str = \"world\") -> str");
    expect(out.paramTypes).toEqual([
      { name: "name", type: "str", optional: true, defaultValue: '"world"' },
    ]);
  });

  it("flags Optional and union-with-None as optional", () => {
    const out = parseHoverText(
      "(function) def lookup(id: str, default: Optional[dict[str, str]] = None) -> dict[str, str] | None",
    );
    expect(out.returnType).toBe("dict[str, str] | None");
    expect(out.paramTypes).toEqual([
      { name: "id", type: "str", optional: false, defaultValue: null },
      {
        name: "default",
        type: "Optional[dict[str, str]]",
        optional: true,
        defaultValue: "None",
      },
    ]);
  });

  it("parses *args / **kwargs", () => {
    const out = parseHoverText("(function) def collect(*args: int, **kwargs: str) -> None");
    expect(out.paramTypes).toEqual([
      { name: "*args", type: "int", optional: false, defaultValue: null },
      { name: "**kwargs", type: "str", optional: false, defaultValue: null },
    ]);
  });

  it("parses a class hover", () => {
    const out = parseHoverText("(class) Greeter");
    expect(out.kindWord).toBe("class");
    expect(out.signature).toBeNull();
    expect(out.paramTypes).toBeNull();
  });

  it("parses a module-level variable", () => {
    const out = parseHoverText("(variable) MAX_RETRIES: int");
    expect(out.kindWord).toBe("variable");
    expect(out.variableType).toBe("int");
    expect(out.signature).toBeNull();
  });

  it("parses a Final-typed constant", () => {
    const out = parseHoverText("(constant) MAX_RETRIES: Final[int] = 5");
    expect(out.kindWord).toBe("constant");
    expect(out.variableType).toBe("Final[int]");
  });

  it("strips a markdown code fence if pyright wraps the hover", () => {
    const out = parseHoverText("```python\n(function) def f() -> int\n```");
    expect(out.kindWord).toBe("function");
    expect(out.returnType).toBe("int");
  });

  it("returns empty fields for malformed input", () => {
    const out = parseHoverText("");
    expect(out.kindWord).toBeNull();
    expect(out.signature).toBeNull();
    expect(out.paramTypes).toBeNull();
  });

  it("does not split on commas inside generic brackets", () => {
    const out = parseHoverText(
      "(function) def map(items: list[T], fn: Callable[[T], R]) -> list[R]",
    );
    expect(out.paramTypes).toEqual([
      { name: "items", type: "list[T]", optional: false, defaultValue: null },
      { name: "fn", type: "Callable[[T], R]", optional: false, defaultValue: null },
    ]);
    expect(out.returnType).toBe("list[R]");
  });

  it("does not treat == in defaults as a top-level =", () => {
    const out = parseHoverText("(function) def cmp(a: int, b: int = 1 == 0) -> bool");
    // The right-hand side here is `1 == 0` (an expression). Our parser should
    // capture it as the default value as a single string.
    expect(out.paramTypes?.[1]).toMatchObject({ name: "b", type: "int" });
    expect(out.paramTypes?.[1]?.defaultValue).toBe("1 == 0");
  });
});
