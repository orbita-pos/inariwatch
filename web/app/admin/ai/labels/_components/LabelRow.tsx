"use client";

import { useState, useTransition } from "react";

const TIERS = ["0", "1", "2", "3"] as const;

export default function LabelRow(props: {
  sessionId: string;
  alertTitle: string;
  classifierTier: string;
  status: string;
  monitoringStatus: string | null;
  patternMatchScore: number | null;
  existingLabel: string | null;
}) {
  const [label, setLabel] = useState<string | null>(props.existingLabel);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(humanTier: string) {
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/admin/tier-router-labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: props.sessionId, humanTier }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setLabel(humanTier);
    });
  }

  const agreementBadge =
    label !== null
      ? label === props.classifierTier
        ? <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">agree</span>
        : <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-500/10 text-amber-400 border border-amber-500/20">disagree</span>
      : null;

  return (
    <tr className="border-b border-zinc-800 hover:bg-zinc-900/30">
      <td className="px-5 py-3 text-zinc-200 max-w-md truncate" title={props.alertTitle}>
        {props.alertTitle}
      </td>
      <td className="px-5 py-3 font-mono text-violet-300">T{props.classifierTier}</td>
      <td className="px-5 py-3 text-zinc-400 text-xs">
        {props.status}
        {props.monitoringStatus ? ` · ${props.monitoringStatus}` : ""}
      </td>
      <td className="px-5 py-3 text-zinc-400 text-xs">
        {props.patternMatchScore !== null ? props.patternMatchScore.toFixed(3) : "—"}
      </td>
      <td className="px-5 py-3">
        <div className="flex items-center gap-1">
          {TIERS.map((t) => {
            const selected = label === t;
            return (
              <button
                key={t}
                type="button"
                disabled={pending}
                onClick={() => submit(t)}
                className={
                  "px-2 py-1 text-xs font-mono rounded border " +
                  (selected
                    ? "bg-violet-500/20 text-violet-300 border-violet-500/40"
                    : "bg-zinc-900 text-zinc-400 border-zinc-700 hover:border-zinc-500")
                }
              >
                T{t}
              </button>
            );
          })}
          {agreementBadge}
        </div>
        {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      </td>
    </tr>
  );
}
