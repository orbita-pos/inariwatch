// /admin/ops Code Intelligence baseline widget — Phase 0.3 of v2.
//
// Surfaces the v1 retrieval baseline (chunk count, embedding coverage, the
// homonym-poisoning rate of the call graph). Once Phase 1 lands, a sibling
// "Code Intel v1 vs v2 Shadow" widget compares against these numbers so
// the cutover decision is data-driven, not vibes.

import { Card, EmptyState, ErrorState } from "./card";
import { headers } from "next/headers";

export const revalidate = 60;

interface BaselineData {
  repos: {
    total: number;
    ready: number;
    indexing: number;
    failed: number;
  };
  chunks: {
    total: number;
    withEmbedding: number;
    embeddingCoveragePct: number;
    byModel: Record<string, number>;
  };
  dependencies: {
    totalEdges: number;
    homonymPoisonedEdges: number;
    poisonedPct: number;
  };
  languages: { language: string; count: number }[];
}

async function getBaseline(): Promise<
  { ok: true; data: BaselineData } | { ok: false; error: string }
> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const url = `${proto}://${host}/api/admin/code-intel/baseline-stats`;
  try {
    const cookie = h.get("cookie") ?? "";
    const res = await fetch(url, {
      headers: { cookie },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, error: `baseline-stats endpoint returned ${res.status}` };
    }
    const data = (await res.json()) as BaselineData;
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function CodeIntelBaselineWidget() {
  const r = await getBaseline();
  return (
    <Card title="Code Intelligence Baseline (v1)" subtitle="reference for v2 A/B">
      {!r.ok ? (
        <ErrorState message={r.error} />
      ) : r.data.chunks.total === 0 ? (
        <EmptyState message="No code chunks indexed yet. Connect a repo to see baseline metrics." />
      ) : (
        <BaselineBody data={r.data} />
      )}
    </Card>
  );
}

function BaselineBody({ data }: { data: BaselineData }) {
  const { repos, chunks, dependencies, languages } = data;
  const poisonedClass =
    dependencies.poisonedPct > 30
      ? "text-amber-500"
      : dependencies.poisonedPct > 10
        ? "text-amber-400"
        : "";
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-baseline justify-between">
        <span className="text-fg-base/60">repos indexed</span>
        <span className="font-mono text-base text-fg-strong">
          {repos.ready.toLocaleString()} / {repos.total.toLocaleString()}
        </span>
      </div>
      {(repos.indexing > 0 || repos.failed > 0) && (
        <div className="font-mono text-fg-base/40">
          {repos.indexing > 0 && <span>indexing {repos.indexing} </span>}
          {repos.failed > 0 && <span className="text-amber-500">failed {repos.failed}</span>}
        </div>
      )}

      <div className="border-t border-line pt-3">
        <div className="flex items-baseline justify-between">
          <span className="text-fg-base/60">chunks</span>
          <span className="font-mono text-base text-fg-strong">
            {chunks.total.toLocaleString()}
          </span>
        </div>
        <div className="mt-1 flex justify-between font-mono text-fg-base/60">
          <span>embedding coverage</span>
          <span>
            {chunks.embeddingCoveragePct}% ({chunks.withEmbedding.toLocaleString()})
          </span>
        </div>
        <div className="mt-1 space-y-0.5 font-mono text-fg-base/40">
          {Object.entries(chunks.byModel)
            .filter(([, count]) => count > 0)
            .map(([model, count]) => (
              <div key={model} className="flex justify-between">
                <span className="truncate">{model}</span>
                <span>{count.toLocaleString()}</span>
              </div>
            ))}
        </div>
      </div>

      <div className="border-t border-line pt-3">
        <div className="flex justify-between font-mono">
          <span className="text-fg-base/60">call-graph edges</span>
          <span>{dependencies.totalEdges.toLocaleString()}</span>
        </div>
        <div className="mt-1 flex justify-between font-mono">
          <span className="text-fg-base/60">homonym-poisoned</span>
          <span className={poisonedClass}>
            {dependencies.poisonedPct}% ({dependencies.homonymPoisonedEdges.toLocaleString()})
          </span>
        </div>
        <div className="mt-1 text-[11px] text-fg-base/40">
          v2 resolves these to FQN-exact references — target ≤ 1%.
        </div>
      </div>

      {languages.length > 0 && (
        <div className="border-t border-line pt-3">
          <div className="text-[11px] uppercase tracking-wide text-fg-base/40">
            languages
          </div>
          <div className="mt-1 space-y-0.5 font-mono">
            {languages.map((l) => (
              <div key={l.language} className="flex justify-between">
                <span className="text-fg-base/60">{l.language}</span>
                <span>{l.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
