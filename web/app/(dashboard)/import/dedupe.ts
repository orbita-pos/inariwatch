/**
 * Dedupe installation rows by installation_id. The /import query
 * unions personal installs (installed_by = me) with org installs
 * (organization_id IN my orgs). A user who BOTH installed personally
 * and is a member of the install's org would otherwise show the row
 * twice — once per branch of the OR.
 *
 * Pure function so vitest can cover it without booting Drizzle.
 */

export interface InstallRow {
  installationId: number;
  accountLogin:   string;
}

export function dedupeInstallsByInstallationId(rows: InstallRow[]): InstallRow[] {
  const seen = new Map<number, InstallRow>();
  for (const r of rows) seen.set(r.installationId, r);
  return Array.from(seen.values());
}
