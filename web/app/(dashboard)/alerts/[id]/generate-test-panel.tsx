"use client";

/**
 * Generate regression test from an alert.
 *
 * Two modes inside this panel:
 *   1. Auto-detect — we parse the top non-vendor frame of the stack
 *      trace into a path; user clicks one button.
 *   2. Manual — user types/pastes a path themselves.
 *
 * On submit, hits POST /api/test-generation/start. While the three-pass
 * pipeline runs (30-60s typical), we show a progress UI. On completion,
 * links to /tests/[id] for the full detail view.
 */

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FlaskConical, Loader2, CheckCircle2, XCircle, FileCode, ChevronDown, Activity } from "lucide-react";

interface Props {
  alertId: string;
  projectId: string;
  /** Suggested file path extracted server-side from the top stack frame. */
  suggestedPath: string | null;
  /**
   * Substrate recording attached to this alert, if any. When present
   * the panel offers a "Generate from recording" source — the moat
   * feature for Inari Guard. null when no recording exists.
   */
  recordingId: string | null;
  recordingEventCount: number | null;
}

type DeliveryMode = "inline" | "pr";
type SourceMode = "file" | "recording";

interface GenerateResult {
  sessionId: string;
  status: "ready" | "delivered" | "failed";
  costCents: number;
  durationMs: number;
  error?: string;
  testFile?: { path: string; content: string };
  prUrl?: string | null;
  prNumber?: number | null;
}

export function GenerateTestPanel({ alertId, projectId, suggestedPath, recordingId, recordingEventCount }: Props) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [sourceMode, setSourceMode] = useState<SourceMode>(recordingId ? "recording" : "file");
  const [filePath, setFilePath] = useState(suggestedPath ?? "");
  const [fileContent, setFileContent] = useState("");
  const [delivery, setDelivery] = useState<DeliveryMode>("inline");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset to suggested path when prop changes (e.g., page refresh)
  useEffect(() => {
    if (!filePath && suggestedPath) setFilePath(suggestedPath);
  }, [suggestedPath, filePath]);

  async function handleGenerate() {
    if (sourceMode === "file") {
      if (!filePath.trim()) {
        setError("Path is required");
        return;
      }
      if (!fileContent.trim()) {
        setError("Paste the file content below — we don't fetch from GitHub yet in MVP");
        return;
      }
    } else if (!recordingId) {
      setError("No Substrate recording attached to this alert");
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const requestBody: Record<string, unknown> = {
        projectId,
        alertId,
        delivery,
      };
      if (sourceMode === "file") {
        requestBody.filePath = filePath.trim();
        requestBody.fileContent = fileContent;
      } else {
        requestBody.recordingId = recordingId;
      }
      const res = await fetch("/api/test-generation/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Request failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as GenerateResult;
      setResult(data);
      if (data.status === "ready") {
        // Refresh the page list / detail page so it picks up the new row
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // ── Collapsed state (default) ───────────────────────────────────────────
  if (!expanded && !submitting && !result) {
    return (
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 mb-4">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full flex items-center justify-between text-left"
        >
          <div className="flex items-center gap-2.5">
            <FlaskConical size={16} className="text-inari-accent" aria-hidden />
            <div>
              <div className="text-sm font-medium">Generate regression test</div>
              <div className="text-xs text-zinc-500">
                {suggestedPath ? (
                  <>For <code className="font-mono">{suggestedPath}</code></>
                ) : (
                  <>Inari Guard — three-pass AI test generator</>
                )}
              </div>
            </div>
          </div>
          <ChevronDown size={14} className="text-zinc-400" aria-hidden />
        </button>
      </div>
    );
  }

  // ── Submitting state ───────────────────────────────────────────────────
  if (submitting) {
    return (
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 mb-4">
        <div className="flex items-center gap-2.5 mb-2">
          <Loader2 size={16} className="text-inari-accent animate-spin" aria-hidden />
          <div className="text-sm font-medium">Generating tests for {filePath}…</div>
        </div>
        <div className="text-xs text-zinc-500 ml-7">
          Pass 1 plan → Pass 2 code → Pass 3 review → static gates. Typically 30-60s.
        </div>
      </div>
    );
  }

  // ── Result state ───────────────────────────────────────────────────────
  if (result) {
    const ok = result.status === "ready";
    return (
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 mb-4">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2.5">
            {ok ? (
              <CheckCircle2 size={16} className="text-emerald-500" aria-hidden />
            ) : (
              <XCircle size={16} className="text-red-500" aria-hidden />
            )}
            <div>
              <div className="text-sm font-medium">
                {ok ? "Test ready" : "Generation failed"}
              </div>
              <div className="text-xs text-zinc-500 tabular-nums">
                ${(result.costCents / 100).toFixed(3)} · {(result.durationMs / 1000).toFixed(1)}s
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setResult(null);
              setExpanded(false);
              setFilePath(suggestedPath ?? "");
              setFileContent("");
            }}
            className="text-xs text-zinc-400 hover:text-zinc-600"
          >
            Reset
          </button>
        </div>
        {result.error ? (
          <div className="text-xs text-red-600 dark:text-red-400 ml-7">{result.error}</div>
        ) : null}
        {ok && result.testFile ? (
          <div className="ml-7 mt-2 text-xs space-y-1.5">
            <div className="flex items-center gap-1.5 text-zinc-600">
              <FileCode size={12} aria-hidden />
              <span className="font-mono">{result.testFile.path}</span>
            </div>
            {result.prUrl ? (
              <a
                href={result.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-600 dark:text-emerald-400 hover:underline inline-block"
              >
                ✓ PR #{result.prNumber} opened on GitHub →
              </a>
            ) : null}
            <Link
              href={`/tests/${result.sessionId}`}
              className="text-inari-accent hover:underline inline-block"
            >
              View full detail · plan · gates · code →
            </Link>
          </div>
        ) : null}
      </div>
    );
  }

  // ── Expanded form ───────────────────────────────────────────────────────
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 mb-4">
      <div className="flex items-center gap-2.5 mb-3">
        <FlaskConical size={16} className="text-inari-accent" aria-hidden />
        <div className="text-sm font-medium">Generate regression test</div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="ml-auto text-xs text-zinc-400 hover:text-zinc-600"
        >
          Cancel
        </button>
      </div>
      <div className="space-y-2.5">
        {/* Source picker — show only when a Substrate recording is
            attached to the alert (otherwise file is the only option) */}
        {recordingId ? (
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">Source</label>
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="source"
                  value="recording"
                  checked={sourceMode === "recording"}
                  onChange={() => setSourceMode("recording")}
                />
                <Activity size={11} className="text-emerald-500" aria-hidden />
                <span>
                  Substrate recording
                  {recordingEventCount ? (
                    <span className="text-zinc-400"> · {recordingEventCount} events</span>
                  ) : null}
                </span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="source"
                  value="file"
                  checked={sourceMode === "file"}
                  onChange={() => setSourceMode("file")}
                />
                <FileCode size={11} className="text-zinc-400" aria-hidden />
                <span>File content (paste below)</span>
              </label>
            </div>
            <p className="text-xs text-zinc-400 mt-1 leading-tight">
              {sourceMode === "recording"
                ? "We'll generate a regression test from the real I/O captured for this alert."
                : "Manually point us at a source file — paste content for now."}
            </p>
          </div>
        ) : null}

        {sourceMode === "file" ? (
          <>
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">File path (repo-relative)</label>
              <input
                type="text"
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder="src/lib/auth.ts"
                className="w-full px-2 py-1.5 text-sm font-mono rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 focus:outline-none focus:ring-1 focus:ring-inari-accent"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">
                File content
                <span className="text-zinc-400 ml-1">
                  (paste it — MVP doesn't fetch from GitHub yet)
                </span>
              </label>
              <textarea
                value={fileContent}
                onChange={(e) => setFileContent(e.target.value)}
                rows={6}
                placeholder="// Paste the full content of the file you want tested"
                className="w-full px-2 py-1.5 text-xs font-mono rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 focus:outline-none focus:ring-1 focus:ring-inari-accent"
              />
            </div>
          </>
        ) : null}
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Delivery</label>
          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="delivery"
                value="inline"
                checked={delivery === "inline"}
                onChange={() => setDelivery("inline")}
              />
              <span>Inline — return in response, copy manually</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="delivery"
                value="pr"
                checked={delivery === "pr"}
                onChange={() => setDelivery("pr")}
              />
              <span>Open PR — push branch + draft PR on GitHub</span>
            </label>
          </div>
        </div>
        {error ? (
          <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
        ) : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={
              submitting ||
              (sourceMode === "file" && (!filePath.trim() || !fileContent.trim())) ||
              (sourceMode === "recording" && !recordingId)
            }
            className="px-3 py-1.5 text-sm rounded bg-inari-accent text-white hover:bg-inari-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Generate
          </button>
          <span className="text-xs text-zinc-500">
            Cost ~$0.10-0.15 · 30-60s
          </span>
        </div>
      </div>
    </div>
  );
}
