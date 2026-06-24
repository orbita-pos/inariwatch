"use client";

import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * Isolated error boundary for the Preview Fix panel.
 *
 * If the PreviewPanel ever throws during render or mount (hydration
 * mismatch, client-side API call mishandled, bad state transition), the
 * rest of the alert detail page must keep rendering — users still need
 * to access remediation actions, comments, everything else.
 *
 * Only scoped to PreviewPanel. The surrounding (dashboard) error boundary
 * still catches everything outside this subtree.
 */

interface State {
  hasError: boolean;
  message: string;
  digest: string | null;
}

export class PreviewPanelBoundary extends Component<
  { children: ReactNode },
  State
> {
  state: State = { hasError: false, message: "", digest: null };

  static getDerivedStateFromError(error: Error & { digest?: string }): State {
    return {
      hasError: true,
      message: error.message || "Unknown error",
      digest: error.digest ?? null,
    };
  }

  componentDidCatch(error: Error) {
    console.error("[PreviewPanelBoundary] captured:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                Preview panel failed to load
              </p>
              <p className="mt-1 text-xs text-fg-base/70 break-words">
                {this.state.message}
              </p>
              {this.state.digest && (
                <p className="mt-1 font-mono text-[10px] text-fg-base/40">
                  digest: {this.state.digest}
                </p>
              )}
              <p className="mt-2 text-[11px] text-fg-base/60">
                The rest of this page is still functional — remediation,
                comments, and EAP attestation all work normally.
              </p>
            </div>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
