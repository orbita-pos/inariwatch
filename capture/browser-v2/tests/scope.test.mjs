import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setUser,
  setTag,
  setRequestContext,
  getUser,
  getTags,
  getRequestContext,
  getBreadcrumbs,
  clearScope,
  redactBody,
  scrubUrl,
  scrubSecrets,
} from "../dist/scope.js";
import { addBreadcrumb } from "../dist/scope.js";

test("setUser does not include email", () => {
  clearScope();
  setUser("u1", "admin");
  const u = getUser();
  assert.equal(u.id, "u1");
  assert.equal(u.role, "admin");
  assert.equal(u.email, undefined);
});

test("setTag accumulates", () => {
  clearScope();
  setTag("region", "us-east-1");
  setTag("k8s_namespace", "prod");
  const tags = getTags();
  assert.equal(tags.region, "us-east-1");
  assert.equal(tags.k8s_namespace, "prod");
});

test("setRequestContext redacts headers", () => {
  clearScope();
  setRequestContext({
    method: "POST",
    url: "/x",
    headers: {
      Authorization: "Bearer abc",
      "X-Auth-Token": "leak",
      Accept: "application/json",
    },
  });
  const req = getRequestContext();
  assert.equal(req.headers.Authorization, "[REDACTED]");
  assert.equal(req.headers["X-Auth-Token"], "[REDACTED]");
  assert.equal(req.headers.Accept, "application/json");
});

test("redactBody scrubs nested secrets", () => {
  const safe = redactBody({
    user: "alice",
    password: "hunter2",
    nested: { api_key: "sk_xxx", deep: { token: "leak" } },
    items: [{ secret: "X", ok: "Y" }],
  });
  assert.equal(safe.password, "[REDACTED]");
  assert.equal(safe.nested.api_key, "[REDACTED]");
  assert.equal(safe.nested.deep.token, "[REDACTED]");
  assert.equal(safe.items[0].secret, "[REDACTED]");
  assert.equal(safe.items[0].ok, "Y");
});

test("breadcrumb ring caps at 30", () => {
  clearScope();
  for (let i = 0; i < 50; i++) addBreadcrumb({ category: "test", message: `crumb-${i}` });
  const crumbs = getBreadcrumbs();
  assert.equal(crumbs.length, 30);
  assert.equal(crumbs[0].message, "crumb-20");
  assert.equal(crumbs[29].message, "crumb-49");
});

test("scrubUrl redacts sensitive query params", () => {
  const out = scrubUrl("https://api.example.com/x?token=abc&page=2");
  assert.ok(out.includes("token=[REDACTED]"));
  assert.ok(out.includes("page=2"));
});

test("scrubSecrets removes bearer tokens", () => {
  const out = scrubSecrets("Authorization: Bearer abc123");
  assert.ok(out.includes("[REDACTED]"));
});
