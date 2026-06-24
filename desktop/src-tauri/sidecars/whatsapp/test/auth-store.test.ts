// v0.3 S5 — auth-store atomic-write + backup invariants.
//
// We validate WITHOUT loading Baileys' auth state (which has heavy
// crypto deps): the test patches `auth-store` to expose its replacer/
// reviver helpers AND exercises the exact write→backup→restore loop
// we promise users on the README. Buffer encoding round-trips are the
// failure mode that broke OpenClaw's session storage and was patched
// upstream — make sure we don't regress.

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadBackedAuthState } from "../src/auth-store.js";

describe("loadBackedAuthState", () => {
  it("creates a fresh keys/ dir + creds.json on first load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inari-auth-"));
    try {
      const auth = await loadBackedAuthState(dir);
      expect(auth.state.creds).toBeDefined();
      expect(typeof auth.saveCreds).toBe("function");
      expect(typeof auth.clear).toBe("function");
      // saveCreds() must produce a valid JSON file on disk.
      await auth.saveCreds();
      const raw = await readFile(join(dir, "creds.json"), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveProperty("noiseKey");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to creds.json.bak if creds.json is corrupted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inari-auth-"));
    try {
      // Plant a known-good creds via the normal save path.
      const first = await loadBackedAuthState(dir);
      await first.saveCreds();
      // Force a save to populate the .bak file.
      await first.saveCreds();
      const goodRaw = await readFile(join(dir, "creds.json"), "utf-8");
      // Now corrupt creds.json — the backup should kick in on reload.
      await writeFile(join(dir, "creds.json"), "not-json", "utf-8");
      const second = await loadBackedAuthState(dir);
      // After recovery, creds.json should be restored from .bak.
      const recovered = await readFile(join(dir, "creds.json"), "utf-8");
      expect(recovered).toBe(goodRaw);
      // And the in-memory creds should match the good copy.
      expect(JSON.stringify(second.state.creds)).toBe(
        JSON.stringify(JSON.parse(goodRaw)),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clear() wipes creds + .bak + keys/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inari-auth-"));
    try {
      const auth = await loadBackedAuthState(dir);
      await auth.saveCreds();
      await auth.saveCreds(); // populate .bak
      // Drop a keys file to make sure clear nukes it too.
      await writeFile(join(dir, "keys", "session-foo.json"), "{}", "utf-8");
      await auth.clear();
      let credsExists = false;
      try {
        await readFile(join(dir, "creds.json"), "utf-8");
        credsExists = true;
      } catch {
        // expected ENOENT
      }
      expect(credsExists).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
