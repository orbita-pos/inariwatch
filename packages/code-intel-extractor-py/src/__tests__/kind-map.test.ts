// Pure unit tests for kind-map.ts. No LSP / no fixtures.

import { describe, it, expect } from "vitest";

import { mapLspKind, visibilityFromName } from "../kind-map.js";

describe("mapLspKind", () => {
  it("maps Class (5)", () => {
    expect(mapLspKind(5, false)).toEqual({ kind: "class" });
  });

  it("maps Method (6) with class parent", () => {
    expect(mapLspKind(6, true)).toEqual({ kind: "method", isClassMember: true });
  });

  it("maps Function (12) at module scope", () => {
    expect(mapLspKind(12, false)).toEqual({ kind: "function" });
  });

  it("promotes Function (12) inside a class to method", () => {
    expect(mapLspKind(12, true)).toEqual({ kind: "method", isClassMember: true });
  });

  it("maps Variable (13)", () => {
    expect(mapLspKind(13, false)).toEqual({ kind: "variable" });
  });

  it("maps Constant (14) to variable", () => {
    expect(mapLspKind(14, false)).toEqual({ kind: "variable" });
  });

  it("maps Enum (10)", () => {
    expect(mapLspKind(10, false)).toEqual({ kind: "enum" });
  });

  it("maps Struct (23) — used by pyright for dataclass — to class", () => {
    expect(mapLspKind(23, false)).toEqual({ kind: "class" });
  });

  it("maps TypeParameter (26) to type", () => {
    expect(mapLspKind(26, false)).toEqual({ kind: "type" });
  });

  it("returns null for unknown kinds", () => {
    expect(mapLspKind(999, false)).toBeNull();
    expect(mapLspKind(1, false)).toBeNull(); // File
    expect(mapLspKind(2, false)).toBeNull(); // Module
  });
});

describe("visibilityFromName", () => {
  it("treats single underscore as private", () => {
    expect(visibilityFromName("_helper")).toBe("private");
  });

  it("treats double underscore (no trailing) as private", () => {
    expect(visibilityFromName("__mangled")).toBe("private");
  });

  it("treats dunder methods as public (no marker)", () => {
    expect(visibilityFromName("__init__")).toBeNull();
    expect(visibilityFromName("__str__")).toBeNull();
  });

  it("returns null for plain names", () => {
    expect(visibilityFromName("foo")).toBeNull();
    expect(visibilityFromName("UpperCase")).toBeNull();
  });
});
