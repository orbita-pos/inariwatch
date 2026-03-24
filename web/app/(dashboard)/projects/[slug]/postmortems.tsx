"use client";

import { useState } from "react";

type PostmortemItem = {
  id: string;
  alertTitle: string;
  severity: string;
  postmortem: string;
  createdAt: string;
  resolvedAt: string | null;
};

export function PostmortemsSection({ postmortems }: { postmortems: PostmortemItem[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (postmortems.length === 0) {
    return (
      <section>
        <h2 className="text-lg font-semibold mb-3">Post-mortems</h2>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center">
          <p className="text-sm text-zinc-500">No post-mortems yet. They are auto-generated when alerts are resolved via AI remediation.</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3">Post-mortems ({postmortems.length})</h2>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 divide-y divide-zinc-800">
        {postmortems.map((pm) => {
          const isOpen = expanded === pm.id;
          return (
            <div key={pm.id} className="p-4">
              <button
                onClick={() => setExpanded(isOpen ? null : pm.id)}
                className="w-full text-left"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-200 truncate">{pm.alertTitle}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        pm.severity === "critical" ? "bg-red-900/50 text-red-400"
                          : pm.severity === "warning" ? "bg-amber-900/50 text-amber-400"
                          : "bg-blue-900/50 text-blue-400"
                      }`}>
                        {pm.severity}
                      </span>
                      <span className="text-xs text-zinc-600">
                        {new Date(pm.createdAt).toLocaleDateString("en-US", {
                          month: "short", day: "numeric", year: "numeric",
                        })}
                      </span>
                    </div>
                  </div>
                  <span className="text-xs text-zinc-600 ml-2 mt-1">{isOpen ? "▲" : "▼"}</span>
                </div>
              </button>
              {isOpen && (
                <div className="mt-3 text-sm text-zinc-400 whitespace-pre-wrap border-l-2 border-zinc-700 pl-4 max-h-96 overflow-y-auto">
                  {pm.postmortem}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
