// Pure unit tests for fqn.ts. Mirrors the TS extractor's fqn tests.

import { describe, it, expect } from "vitest";

import {
  buildFqn,
  fqnFile,
  fqnLeafName,
  fqnOwnerChain,
  fqnParent,
  normalizePath,
} from "../fqn.js";

describe("FQN helpers", () => {
  it("buildFqn round-trips", () => {
    const fqn = buildFqn("app/main.py", ["UserService", "find_by_id"]);
    expect(fqn).toBe("app/main.py::UserService.find_by_id");
    expect(fqnFile(fqn)).toBe("app/main.py");
    expect(fqnOwnerChain(fqn)).toEqual(["UserService", "find_by_id"]);
    expect(fqnLeafName(fqn)).toBe("find_by_id");
    expect(fqnParent(fqn)).toBe("app/main.py::UserService");
  });

  it("buildFqn rejects empty owner chain", () => {
    expect(() => buildFqn("a.py", [])).toThrow(/empty owner chain/);
  });

  it("fqnParent returns null for module-level", () => {
    expect(fqnParent("a.py::foo")).toBeNull();
  });

  it("normalizePath converts backslashes", () => {
    expect(normalizePath("a\\b\\c.py")).toBe("a/b/c.py");
    expect(normalizePath("a/b/c.py")).toBe("a/b/c.py");
  });
});
