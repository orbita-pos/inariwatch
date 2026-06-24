/**
 * The /import installations query unions personal installs and org
 * installs in a single SELECT. A user who is BOTH the installer AND
 * a member of the install's org would otherwise see the row twice —
 * dedupeInstallsByInstallationId collapses those duplicates.
 *
 * The Map keeps the LAST occurrence per id; in practice the rows are
 * identical when duplicated (same installationId implies same row),
 * so "last wins" is harmless.
 */

import { describe, it, expect } from "vitest";
import { dedupeInstallsByInstallationId, type InstallRow } from "../dedupe";

describe("dedupeInstallsByInstallationId", () => {
  it("returns an empty array for empty input", () => {
    expect(dedupeInstallsByInstallationId([])).toEqual([]);
  });

  it("returns a single row unchanged", () => {
    const rows: InstallRow[] = [{ installationId: 1, accountLogin: "alice" }];
    expect(dedupeInstallsByInstallationId(rows)).toEqual(rows);
  });

  it("collapses duplicates by installationId (installer + org-member case)", () => {
    // Same install surfaces from both branches of the OR — installer
    // match and org-member match. The dedupe should leave one entry.
    const rows: InstallRow[] = [
      { installationId: 42, accountLogin: "acme" },
      { installationId: 42, accountLogin: "acme" },
    ];
    const out = dedupeInstallsByInstallationId(rows);
    expect(out).toHaveLength(1);
    expect(out[0].installationId).toBe(42);
  });

  it("preserves distinct installations", () => {
    const rows: InstallRow[] = [
      { installationId: 1, accountLogin: "alice" },
      { installationId: 2, accountLogin: "acme" },
      { installationId: 3, accountLogin: "globex" },
    ];
    const out = dedupeInstallsByInstallationId(rows);
    expect(out).toHaveLength(3);
    const ids = out.map((r) => r.installationId).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3]);
  });

  it("dedupes a mixed list with multiple duplicates", () => {
    const rows: InstallRow[] = [
      { installationId: 1, accountLogin: "alice" },
      { installationId: 2, accountLogin: "acme" },
      { installationId: 1, accountLogin: "alice" },
      { installationId: 2, accountLogin: "acme" },
      { installationId: 3, accountLogin: "globex" },
    ];
    const out = dedupeInstallsByInstallationId(rows);
    expect(out).toHaveLength(3);
  });
});
