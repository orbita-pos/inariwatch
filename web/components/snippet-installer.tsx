"use client";

/**
 * Reusable "Install @inariwatch/capture" snippet card with a single-click
 * Copy button. Used on alert-detail pages (to upsell session replay) and
 * on onboarding. All fields are optional — when projectId/dsn are missing
 * the snippet falls back to placeholders.
 */

import { useState } from "react";
import { Clipboard, Check, Terminal, Code2 } from "lucide-react";

interface SnippetInstallerProps {
  /** Project UUID — rendered into the NEXT_PUBLIC env var. */
  projectId?: string;
  /** DSN — rendered into the NEXT_PUBLIC env var. */
  dsn?: string;
  /** Project-facing name — shown in the card header. */
  projectName?: string;
  /** Collapsed by default; the user clicks "Show" to expand. */
  defaultCollapsed?: boolean;
}

function buildInstallCommand() {
  return "npx @inariwatch/capture init";
}

function buildManualSnippet(projectId: string, dsn: string): string {
  return [
    "// app/capture-init.tsx",
    `"use client"`,
    `import { useEffect } from "react"`,
    ``,
    `export function CaptureInit() {`,
    `  useEffect(() => {`,
    `    void (async () => {`,
    `      const [{ init }, { replayIntegration }] = await Promise.all([`,
    `        import("@inariwatch/capture"),`,
    `        import("@inariwatch/capture-replay"),`,
    `      ])`,
    `      init({`,
    `        dsn: "${dsn}",`,
    `        projectId: "${projectId}",`,
    `        integrations: [replayIntegration()],`,
    `      })`,
    `    })()`,
    `  }, [])`,
    `  return null`,
    `}`,
  ].join("\n");
}

function buildEnvSnippet(projectId: string, dsn: string): string {
  return [
    "# Add to .env.local",
    `NEXT_PUBLIC_INARIWATCH_PROJECT_ID=${projectId}`,
    `NEXT_PUBLIC_INARIWATCH_DSN=${dsn}`,
  ].join("\n");
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. http:// without secure context); just ignore.
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-inner px-2.5 py-1 text-xs font-medium text-fg-base transition-colors hover:bg-surface-dim"
      aria-label={label}
    >
      {copied ? (
        <>
          <Check className="h-3 w-3 text-emerald-500" aria-hidden="true" />
          Copied
        </>
      ) : (
        <>
          <Clipboard className="h-3 w-3" aria-hidden="true" />
          {label}
        </>
      )}
    </button>
  );
}

export function SnippetInstaller({
  projectId = "your-project-uuid",
  dsn = "https://<your-dsn>@app.inariwatch.com",
  projectName,
  defaultCollapsed = false,
}: SnippetInstallerProps) {
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const cli = buildInstallCommand();
  const manual = buildManualSnippet(projectId, dsn);
  const env = buildEnvSnippet(projectId, dsn);

  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-fg-base/60" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-fg-strong">
            Add session replay{projectName ? ` to ${projectName}` : ""}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-xs text-fg-base/70 transition-colors hover:text-fg-strong"
        >
          {expanded ? "Hide" : "Show"}
        </button>
      </header>

      {expanded && (
        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-fg-base">
            Record the user session that triggered this alert — click, input,
            network, console, frame-by-frame. PII masking is automatic.
          </p>

          {/* Recommended: CLI */}
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-fg-base/60">
              <Terminal className="h-3 w-3" aria-hidden="true" />
              Recommended (auto-setup)
            </div>
            <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-black/[0.04] dark:bg-white/[0.04] px-3 py-2 font-mono text-xs">
              <code className="truncate">{cli}</code>
              <CopyButton text={cli} />
            </div>
            <p className="mt-1.5 text-[11px] text-fg-base/60">
              Detects your framework, installs both packages, scaffolds the
              client component, and writes the env vars.
            </p>
          </div>

          {/* Fallback: manual */}
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fg-base/60">
              Or paste manually
            </div>
            <div className="overflow-hidden rounded-md border border-line bg-black/[0.04] dark:bg-white/[0.04]">
              <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
                <span className="font-mono text-[11px] text-fg-base/70">app/capture-init.tsx</span>
                <CopyButton text={manual} />
              </div>
              <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-base">
                {manual}
              </pre>
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fg-base/60">
              Env vars
            </div>
            <div className="overflow-hidden rounded-md border border-line bg-black/[0.04] dark:bg-white/[0.04]">
              <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
                <span className="font-mono text-[11px] text-fg-base/70">.env.local</span>
                <CopyButton text={env} />
              </div>
              <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-base">
                {env}
              </pre>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
