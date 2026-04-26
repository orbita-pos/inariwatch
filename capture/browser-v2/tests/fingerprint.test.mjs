import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import { computeErrorFingerprint } from "../dist/fingerprint.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

test("cross-language golden vectors", async () => {
  const path = join(REPO_ROOT, "shared", "fingerprint-test-vectors.json");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const failures = [];
  for (const v of parsed.vectors) {
    const got = await computeErrorFingerprint(v.title, v.body);
    if (got !== v.expected) {
      failures.push(`${v.id}: expected ${v.expected} got ${got}`);
    }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
  assert.ok(parsed.vectors.length >= 20, `expected 20+ vectors, found ${parsed.vectors.length}`);
});

test("same input produces same hash", async () => {
  assert.equal(
    await computeErrorFingerprint("Err", "stack"),
    await computeErrorFingerprint("Err", "stack")
  );
});

test("different uuids produce same hash", async () => {
  const a = await computeErrorFingerprint(
    "Err",
    "user 550e8400-e29b-41d4-a716-446655440000 not found"
  );
  const b = await computeErrorFingerprint(
    "Err",
    "user 6ba7b810-9dad-11d1-80b4-00c04fd430c8 not found"
  );
  assert.equal(a, b);
});
