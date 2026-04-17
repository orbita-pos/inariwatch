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
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCloneUrl,
  isSafePath,
  scrub,
  ensureNoSymlinksInAncestors,
} from "../prepare-workspace.js";

async function scratch(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "iw-pw-test-"));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

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

// ── ensureNoSymlinksInAncestors ───────────────────────────────────────────
//
// Windows creates symlinks only with elevated privileges (or Developer
// Mode). Since the worker runs on Linux in production, skipping the
// symlink tests on Windows is acceptable — the CI of the monorepo and
// Hetzner itself will exercise them.
const SKIP_SYMLINK_TESTS = process.platform === "win32";

test("ensureNoSymlinksInAncestors: accepts plain nested directory", async () => {
  const s = await scratch();
  try {
    await mkdir(join(s.path, "src", "lib"), { recursive: true });
    // Should not throw — every ancestor is a real directory.
    await ensureNoSymlinksInAncestors(s.path, "src/lib/app.ts");
  } finally {
    await s.cleanup();
  }
});

test("ensureNoSymlinksInAncestors: ancestor that doesn't exist yet is OK", async () => {
  const s = await scratch();
  try {
    // `new/deep/nested/path.ts` — none of the ancestors exist; the
    // function should silently pass (mkdir will create them later).
    await ensureNoSymlinksInAncestors(s.path, "new/deep/nested/path.ts");
  } finally {
    await s.cleanup();
  }
});

test("ensureNoSymlinksInAncestors: REJECTS when an ancestor dir is a symlink", { skip: SKIP_SYMLINK_TESTS }, async () => {
  const s = await scratch();
  try {
    // Simulate a repo that committed `docs` as a symlink pointing at /etc.
    // Use a sibling tmp dir as a safe symlink target so we're not actually
    // poking /etc during tests.
    const evilTarget = await scratch();
    try {
      await symlink(evilTarget.path, join(s.path, "docs"));
      await assert.rejects(
        ensureNoSymlinksInAncestors(s.path, "docs/passwd"),
        /symlinked ancestor/,
      );
    } finally {
      await evilTarget.cleanup();
    }
  } finally {
    await s.cleanup();
  }
});

test("ensureNoSymlinksInAncestors: REJECTS when a deep ancestor is a symlink", { skip: SKIP_SYMLINK_TESTS }, async () => {
  const s = await scratch();
  try {
    await mkdir(join(s.path, "real"), { recursive: true });
    const evilTarget = await scratch();
    try {
      // real/ is a real directory, but real/escape is a symlink.
      // Writing to real/escape/x.txt should be blocked because escape
      // dir is a symlink.
      await symlink(evilTarget.path, join(s.path, "real", "escape"));
      await assert.rejects(
        ensureNoSymlinksInAncestors(s.path, "real/escape/file.txt"),
        /symlinked ancestor/,
      );
    } finally {
      await evilTarget.cleanup();
    }
  } finally {
    await s.cleanup();
  }
});

test("ensureNoSymlinksInAncestors: does NOT check the final file component", { skip: SKIP_SYMLINK_TESTS }, async () => {
  // The final component is handled by O_NOFOLLOW on open(), not here.
  // This test locks in that the ancestor-walker stops before the leaf.
  const s = await scratch();
  try {
    const evilTarget = await scratch();
    try {
      await writeFile(join(evilTarget.path, "target"), "original");
      await symlink(join(evilTarget.path, "target"), join(s.path, "leaflink"));
      // The file itself is a symlink, but it's the leaf — ancestors are fine.
      await ensureNoSymlinksInAncestors(s.path, "leaflink");
    } finally {
      await evilTarget.cleanup();
    }
  } finally {
    await s.cleanup();
  }
});
