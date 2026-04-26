import test from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  __setSessionDirForTest,
  __sessionFileState,
  installSessionFile,
  updateRequestContext,
  uninstallSessionFile,
} from "../dist/session-file.js"

const isLinux = process.platform === "linux"

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "iw-session-"))
}

function readPayload(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>
}

test("install writes a v1 schema file with the session id", { skip: !isLinux }, () => {
  const dir = freshTmpDir()
  __setSessionDirForTest(dir)
  try {
    const filePath = installSessionFile({ sessionId: "test-session-1" })
    assert.ok(filePath, "expected install to return a path on Linux")
    const payload = readPayload(filePath!)
    assert.equal(payload.schema, "iw.session.v1")
    assert.equal(payload.session_id, "test-session-1")
    assert.equal(payload.pid, process.pid)
    assert.ok(typeof payload.updated_ns === "number" && payload.updated_ns > 0)
    assert.equal(payload.request_id, undefined)
    assert.equal(payload.user_id, undefined)
  } finally {
    uninstallSessionFile()
    __setSessionDirForTest(null)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("install includes optional request and user ids", { skip: !isLinux }, () => {
  const dir = freshTmpDir()
  __setSessionDirForTest(dir)
  try {
    const filePath = installSessionFile({
      sessionId: "sess-with-context",
      requestId: "req-99",
      userId: "u-7",
    })
    const payload = readPayload(filePath!)
    assert.equal(payload.request_id, "req-99")
    assert.equal(payload.user_id, "u-7")
  } finally {
    uninstallSessionFile()
    __setSessionDirForTest(null)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("install throws when sessionId is empty", () => {
  assert.throws(() => installSessionFile({ sessionId: "" }), /sessionId is required/)
})

test(
  "updateRequestContext rewrites the file while preserving session_id",
  { skip: !isLinux },
  () => {
    const dir = freshTmpDir()
    __setSessionDirForTest(dir)
    try {
      const filePath = installSessionFile({ sessionId: "sess-keep-me" })
      const ok = updateRequestContext({ requestId: "req-new", userId: "u-new" })
      assert.equal(ok, true)
      const payload = readPayload(filePath!)
      assert.equal(payload.session_id, "sess-keep-me")
      assert.equal(payload.request_id, "req-new")
      assert.equal(payload.user_id, "u-new")
    } finally {
      uninstallSessionFile()
      __setSessionDirForTest(null)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  },
)

test("updateRequestContext is a no-op when nothing is installed", () => {
  __setSessionDirForTest(freshTmpDir())
  const ok = updateRequestContext({ requestId: "irrelevant" })
  assert.equal(ok, false)
  __setSessionDirForTest(null)
})

test("uninstall removes the file and clears state", { skip: !isLinux }, () => {
  const dir = freshTmpDir()
  __setSessionDirForTest(dir)
  try {
    const filePath = installSessionFile({ sessionId: "to-be-deleted" })
    assert.ok(fs.existsSync(filePath!))
    uninstallSessionFile()
    assert.equal(fs.existsSync(filePath!), false)
    assert.equal(__sessionFileState(), null)
  } finally {
    __setSessionDirForTest(null)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("uninstall is safe to call when nothing is installed", () => {
  uninstallSessionFile()
  assert.equal(__sessionFileState(), null)
})

test("non-Linux platforms install as no-op", { skip: isLinux }, () => {
  const dir = freshTmpDir()
  __setSessionDirForTest(dir)
  try {
    const filePath = installSessionFile({ sessionId: "no-op-platform" })
    assert.equal(filePath, null)
    // State recorded but inactive — uninstall should still be safe.
    const state = __sessionFileState()
    assert.notEqual(state, null)
    assert.equal(state!.active, false)
  } finally {
    uninstallSessionFile()
    __setSessionDirForTest(null)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("install is idempotent and survives repeated calls", { skip: !isLinux }, () => {
  const dir = freshTmpDir()
  __setSessionDirForTest(dir)
  try {
    const a = installSessionFile({ sessionId: "first" })
    const b = installSessionFile({ sessionId: "second" })
    assert.equal(a, b, "second install should overwrite the same path")
    const payload = readPayload(b!)
    assert.equal(payload.session_id, "second")
  } finally {
    uninstallSessionFile()
    __setSessionDirForTest(null)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
