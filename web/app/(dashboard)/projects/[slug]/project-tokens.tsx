/**
 * Project tokens panel — Inari Live V1 (Session 2).
 *
 * Reads tokens via the service (no plaintext, no hash — just fingerprints
 * + lifecycle metadata) and hands them to the client component which owns
 * the create-modal + rotate/revoke buttons.
 */

import { listTokens } from "@/lib/services/project-tokens.service";
import { ProjectTokensClient, type TokenView } from "./project-tokens-client";

export async function ProjectTokensSection({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const rows = await listTokens(projectId);
  const tokens: TokenView[] = rows.map((t) => ({
    id:           t.id,
    fingerprint:  t.fingerprint,
    scope:        t.scope,
    createdAt:    t.createdAt.toISOString(),
    lastUsedAt:   t.lastUsedAt?.toISOString() ?? null,
    revokedAt:    t.revokedAt?.toISOString() ?? null,
    rotatedTo:    t.rotatedTo,
    createdVia:   t.createdVia,
    deviceLabel:  t.deviceLabel,
  }));

  return <ProjectTokensClient projectId={projectId} isAdmin={isAdmin} initialTokens={tokens} />;
}
