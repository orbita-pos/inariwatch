/**
 * Pure helpers for the replay → remediation endpoint.
 */

export interface ChainSummary {
  errorFingerprint: string;
  steps: string[];
}

/**
 * Reduce the `aiChapters` payload stored in replay_sessions to the minimum
 * the remediation prompt needs — one compact string per causal link.
 *
 * Phase 2 writes `{ chapters, chains }`. Older data might be a bare
 * `Chapter[]` array; in that case we return an empty summary. The function
 * never throws and never mutates the input.
 */
export function summarizeChains(raw: unknown): ChainSummary[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const chains = (raw as { chains?: unknown[] }).chains;
  if (!Array.isArray(chains)) return [];

  const out: ChainSummary[] = [];
  for (const c of chains) {
    if (!c || typeof c !== "object") continue;
    const chain = c as {
      errorFingerprint?: string;
      links?: { role?: string; summary?: string; tsRelative?: number }[];
    };
    if (!chain.errorFingerprint || !Array.isArray(chain.links)) continue;
    const steps = chain.links
      .filter((l): l is { role: string; summary: string; tsRelative: number } =>
        typeof l?.role === "string" && typeof l.summary === "string",
      )
      .map((l) => `${l.role} @ ${l.tsRelative}ms: ${l.summary}`);
    out.push({ errorFingerprint: chain.errorFingerprint, steps });
  }
  return out;
}
