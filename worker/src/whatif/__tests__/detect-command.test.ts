/**
 * Tests for detectCommand + parseDockerfileCmd.
 *
 * Run: cd worker && npx tsx --test src/whatif/__tests__/detect-command.test.ts
 *
 * No new deps — uses node:test and fs scratch dirs. Each test creates a
 * fresh tmpdir so there's no cross-test fixture contamination.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCommand, parseDockerfileCmd } from "../detect-command.js";

async function scratch(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "iw-detect-test-"));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

// ── detectCommand: heuristic ladder ────────────────────────────────────────

test("detectCommand: returns null on empty dir", async () => {
  const s = await scratch();
  try {
    assert.equal(await detectCommand(s.path), null);
  } finally {
    await s.cleanup();
  }
});

test("detectCommand: npm_start wins over every fallback", async () => {
  const s = await scratch();
  try {
    await writeFile(
      join(s.path, "package.json"),
      JSON.stringify({ scripts: { start: "node server.js", dev: "nodemon" } }),
    );
    await writeFile(join(s.path, "Dockerfile"), `CMD ["node", "other.js"]`);
    await writeFile(join(s.path, "index.js"), "");
    const cmd = await detectCommand(s.path);
    assert.ok(cmd);
    assert.equal(cmd.source, "npm_start");
    assert.equal(cmd.command, "npm start");
    assert.equal(cmd.sourceFile, "package.json");
  } finally {
    await s.cleanup();
  }
});

test("detectCommand: falls back to npm_dev when start missing", async () => {
  const s = await scratch();
  try {
    await writeFile(
      join(s.path, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev" } }),
    );
    const cmd = await detectCommand(s.path);
    assert.equal(cmd?.source, "npm_dev");
    assert.equal(cmd?.command, "npm run dev");
  } finally {
    await s.cleanup();
  }
});

test("detectCommand: Dockerfile exec form beats node_entry fallback", async () => {
  const s = await scratch();
  try {
    await writeFile(join(s.path, "Dockerfile"), `FROM node:20\nCMD ["node", "app.js"]`);
    await writeFile(join(s.path, "index.js"), "");
    const cmd = await detectCommand(s.path);
    assert.equal(cmd?.source, "dockerfile_exec");
    assert.equal(cmd?.command, "node app.js");
  } finally {
    await s.cleanup();
  }
});

test("detectCommand: Dockerfile shell form", async () => {
  const s = await scratch();
  try {
    await writeFile(join(s.path, "Dockerfile"), `FROM node:20\nCMD node server.js --port 3000`);
    const cmd = await detectCommand(s.path);
    assert.equal(cmd?.source, "dockerfile_shell");
    assert.equal(cmd?.command, "node server.js --port 3000");
  } finally {
    await s.cleanup();
  }
});

test("detectCommand: node_entry fallback (index.js)", async () => {
  const s = await scratch();
  try {
    await writeFile(join(s.path, "index.js"), "");
    const cmd = await detectCommand(s.path);
    assert.equal(cmd?.source, "node_entry");
    assert.equal(cmd?.command, "node index.js");
    assert.equal(cmd?.sourceFile, "index.js");
  } finally {
    await s.cleanup();
  }
});

test("detectCommand: node_entry picks index.js before app.js", async () => {
  const s = await scratch();
  try {
    await writeFile(join(s.path, "index.js"), "");
    await writeFile(join(s.path, "app.js"), "");
    await writeFile(join(s.path, "server.js"), "");
    const cmd = await detectCommand(s.path);
    // Ladder order is index.js → app.js → server.js; first hit wins.
    assert.equal(cmd?.sourceFile, "index.js");
  } finally {
    await s.cleanup();
  }
});

test("detectCommand: src/index.js discovered when root entries absent", async () => {
  const s = await scratch();
  try {
    await mkdir(join(s.path, "src"));
    await writeFile(join(s.path, "src", "index.js"), "");
    const cmd = await detectCommand(s.path);
    assert.equal(cmd?.command, "node src/index.js");
  } finally {
    await s.cleanup();
  }
});

test("detectCommand: malformed package.json falls through ladder", async () => {
  const s = await scratch();
  try {
    await writeFile(join(s.path, "package.json"), "{ not valid json");
    await writeFile(join(s.path, "app.js"), "");
    // Falls through to node_entry when the JSON can't parse — matches
    // real world where users sometimes check in partially-edited files.
    const cmd = await detectCommand(s.path);
    assert.equal(cmd?.source, "node_entry");
    assert.equal(cmd?.command, "node app.js");
  } finally {
    await s.cleanup();
  }
});

test("detectCommand: empty scripts falls through", async () => {
  const s = await scratch();
  try {
    await writeFile(
      join(s.path, "package.json"),
      JSON.stringify({ scripts: { start: "", dev: "   " } }),
    );
    await writeFile(join(s.path, "server.js"), "");
    const cmd = await detectCommand(s.path);
    assert.equal(cmd?.source, "node_entry");
    assert.equal(cmd?.command, "node server.js");
  } finally {
    await s.cleanup();
  }
});

// ── parseDockerfileCmd: direct unit tests ─────────────────────────────────

test("parseDockerfileCmd: exec form with two args", () => {
  const got = parseDockerfileCmd(`FROM node:20\nCMD ["node", "app.js"]`);
  assert.deepEqual(got, { command: "node app.js", source: "dockerfile_exec" });
});

test("parseDockerfileCmd: exec form with args needing quoting", () => {
  const got = parseDockerfileCmd(`CMD ["node", "my app.js"]`);
  assert.deepEqual(got, { command: `node 'my app.js'`, source: "dockerfile_exec" });
});

test("parseDockerfileCmd: last CMD wins (multi-stage Dockerfile)", () => {
  const contents = [
    `FROM builder AS build`,
    `CMD ["node", "build.js"]`,
    `FROM node:20`,
    `CMD ["node", "final.js"]`,
  ].join("\n");
  const got = parseDockerfileCmd(contents);
  assert.equal(got?.command, "node final.js");
});

test("parseDockerfileCmd: rejects sh -c (opaque command)", () => {
  assert.equal(parseDockerfileCmd(`CMD sh -c "node app.js"`), null);
  assert.equal(parseDockerfileCmd(`CMD bash -c 'node app.js'`), null);
});

test("parseDockerfileCmd: handles line continuations", () => {
  const got = parseDockerfileCmd(`CMD node \\\n  app.js \\\n  --port 3000`);
  assert.equal(got?.source, "dockerfile_shell");
  // Continuation marker `\` + newline becomes a single space; the two
  // spaces of indentation on the next line survive verbatim, plus the
  // space before the `\` — so 4 spaces total between each group.
  assert.equal(got?.command, "node    app.js    --port 3000");
});

test("parseDockerfileCmd: strips full-line comments", () => {
  const got = parseDockerfileCmd([
    `# CMD ["fake", "entry.js"]`,
    `FROM node:20`,
    `CMD ["node", "real.js"]`,
  ].join("\n"));
  assert.equal(got?.command, "node real.js");
});

test("parseDockerfileCmd: returns null when no CMD", () => {
  assert.equal(parseDockerfileCmd(`FROM node:20\nRUN npm install`), null);
});

test("parseDockerfileCmd: malformed exec form returns null", () => {
  assert.equal(parseDockerfileCmd(`CMD [broken json`), null);
});

test("parseDockerfileCmd: exec form with non-string array elements returns null", () => {
  assert.equal(parseDockerfileCmd(`CMD ["node", 1234]`), null);
});

test("parseDockerfileCmd: case-insensitive directive match", () => {
  const got = parseDockerfileCmd(`cmd ["node", "lower.js"]`);
  assert.equal(got?.command, "node lower.js");
});
