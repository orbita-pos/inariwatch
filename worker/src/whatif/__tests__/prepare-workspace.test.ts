/**
 * Unit tests for the pure helpers inside prepare-workspace.ts. The
 * git-spawn path is integration-tested via the full worker flow and
 * not covered here — these tests lock down the security-critical
 * helpers that decide what we write to disk and what we leak to logs.
 *
 * Run: cd worker && npx tsx --test src/whatif/__tests__/prepare-workspace.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCloneUrl, isSafePath, scrub } from "../prepare-workspace.js";

// ── buildCloneUrl ─────────────────────────────────────────────────────────

test("buildCloneUrl: anonymous url when token omitted", () => {
  assert.equal(
    buildCloneUrl("orbita-pos/inariwatch", undefined),
    "https://github.com/orbita-pos/inariwatch.git",
  );
});

test("buildCloneUrl: embeds token under x-access-token username", () => {
  assert.equal(
    buildCloneUrl("orbita-pos/inariwatch", "ghp_abc123"),
    "https://x-access-token:ghp_abc123@github.com/orbita-pos/inariwatch.git",
  );
});

test("buildCloneUrl: preserves repo slug verbatim", () => {
  // Repo slug trust is established by the caller — we don't double-validate
  // here, but the URL shape must not mangle it (nested slashes, etc).
  assert.equal(
    buildCloneUrl("some-org/repo-with-dashes", "tok"),
    "https://x-access-token:tok@github.com/some-org/repo-with-dashes.git",
  );
});

// ── isSafePath ────────────────────────────────────────────────────────────

test("isSafePath: accepts normal repo-relative paths", () => {
  assert.equal(isSafePath("src/app.ts"), true);
  assert.equal(isSafePath("README.md"), true);
  assert.equal(isSafePath("deep/nested/dir/file.js"), true);
});

test("isSafePath: rejects parent-directory traversal", () => {
  assert.equal(isSafePath("../escape.txt"), false);
  assert.equal(isSafePath("src/../../escape.txt"), false);
  assert.equal(isSafePath("safe/../..pretend"), false);
});

test("isSafePath: rejects absolute unix paths", () => {
  assert.equal(isSafePath("/etc/passwd"), false);
});

test("isSafePath: rejects absolute windows paths", () => {
  assert.equal(isSafePath("\\windows\\system32"), false);
  assert.equal(isSafePath("C:/Windows/system32"), false);
  assert.equal(isSafePath("D:\\malicious.exe"), false);
});

// ── scrub ────────────────────────────────────────────────────────────────

test("scrub: replaces token with stars", () => {
  assert.equal(
    scrub("fatal: could not resolve url https://x-access-token:secret123@github.com/x/y", "secret123"),
    "fatal: could not resolve url https://x-access-token:***@github.com/x/y",
  );
});

test("scrub: handles multiple occurrences", () => {
  assert.equal(
    scrub("token=AAA and also AAA", "AAA"),
    "token=*** and also ***",
  );
});

test("scrub: noop when token undefined", () => {
  assert.equal(scrub("some stderr", undefined), "some stderr");
});

test("scrub: noop when token absent from text", () => {
  assert.equal(scrub("nothing here", "AAA"), "nothing here");
});
