"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

type PostmortemItem = {
  id:         string;
  alertTitle: string;
  severity:   string;
  postmortem: string;
  createdAt:  string;
  resolvedAt: string | null;
};

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-500/10 text-red-700 dark:text-red-400 border border-red-500/25",
  warning:  "bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/25",
  info:     "bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-500/25",
};

export function PostmortemsSection({ postmortems }: { postmortems: PostmortemItem[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (postmortems.length === 0) {
    return (
      <section aria-labelledby="postmortems-heading">
        <h2 id="postmortems-heading" className="text-lg font-semibold text-fg-strong mb-3">
          Post-mortems
        </h2>
        <div className="rounded-lg border border-line bg-surface p-6 text-center">
          <p className="text-sm text-fg-base">
            No post-mortems yet. They are auto-generated when alerts are resolved via AI remediation.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="postmortems-heading">
      <h2 id="postmortems-heading" className="text-lg font-semibold text-fg-strong mb-3">
        Post-mortems ({postmortems.length})
      </h2>
      <ul className="rounded-lg border border-line bg-surface divide-y divide-line-subtle overflow-hidden">
        {postmortems.map((pm) => {
          const isOpen     = expanded === pm.id;
          const contentId  = `pm-content-${pm.id}`;
          const headingId  = `pm-heading-${pm.id}`;
          const sevStyle   = SEVERITY_STYLES[pm.severity] ?? SEVERITY_STYLES.info;

          return (
            <li key={pm.id} className="p-4">
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : pm.id)}
                aria-expanded={isOpen}
                aria-controls={contentId}
                className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 rounded-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p id={headingId} className="text-sm font-medium text-fg-strong truncate">
                      {pm.alertTitle}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${sevStyle}`}>
                        {pm.severity}
                      </span>
                      <span className="text-xs text-fg-base/70">
                        {new Date(pm.createdAt).toLocaleDateString("en-US", {
                          month: "short", day: "numeric", year: "numeric",
                        })}
                      </span>
                    </div>
                  </div>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 mt-0.5 text-fg-base/60 transition-transform ${isOpen ? "rotate-180" : ""}`}
                    aria-hidden="true"
                  />
                </div>
              </button>
              {isOpen && (
                <div
                  id={contentId}
                  role="region"
                  aria-labelledby={headingId}
                  className="mt-3 text-sm text-fg-base whitespace-pre-wrap border-l-2 border-line-medium pl-4 max-h-96 overflow-y-auto leading-relaxed"
                >
                  {pm.postmortem}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
