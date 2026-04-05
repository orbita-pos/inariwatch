import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { computeErrorFingerprint } from "../fingerprint";

const vectorsPath = resolve(__dirname, "../../../../shared/fingerprint-test-vectors.json");
const data = JSON.parse(readFileSync(vectorsPath, "utf8"));
const vectors: { id: string; title: string; body: string; expected: string }[] = data.vectors;

describe("fingerprint: cross-platform golden vectors", () => {
  for (const v of vectors) {
    it(`[${v.id}] matches expected hash`, () => {
      const actual = computeErrorFingerprint(v.title, v.body);
      expect(actual).toBe(v.expected);
    });
  }
});
