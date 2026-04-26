import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDsn } from "../dist/dsn.js";
import { signSha256Hex } from "../dist/hmac.js";

test("parses local DSN", () => {
  const d = parseDsn("http://devsecret@localhost:3000/capture/abc");
  assert.equal(d.isLocal, true);
  assert.equal(d.projectId, "abc");
  assert.equal(d.secret, "devsecret");
  assert.ok(d.url.endsWith("/api/webhooks/capture/abc"));
});

test("parses cloud DSN", () => {
  const d = parseDsn("https://prodsecret@app.inariwatch.com/capture/proj42");
  assert.equal(d.isLocal, false);
  assert.equal(d.projectId, "proj42");
  assert.ok(d.url.startsWith("https://"));
});

test("http requires localhost", () => {
  assert.throws(() => parseDsn("http://secret@example.com/capture/abc"));
});

test("rejects missing secret", () => {
  assert.throws(() => parseDsn("https://app.inariwatch.com/capture/abc"));
});

test("rejects missing project id", () => {
  assert.throws(() => parseDsn("https://secret@app.inariwatch.com/capture/"));
});

test("hmac matches known reference", async () => {
  const got = await signSha256Hex(new TextEncoder().encode("hello"), "secret");
  assert.equal(got, "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b");
});
