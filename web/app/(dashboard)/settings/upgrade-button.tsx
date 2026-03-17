"use client";

import { useState } from "react";

interface UpgradeButtonProps {
  currentPlan: string;
}

export function UpgradeButton({ currentPlan }: UpgradeButtonProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleUpgrade(plan: "pro" | "team") {
    setLoading(plan);
    setError(null);

    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });

      const data = await res.json();

      if (!res.ok || !data.url) {
        setError(data.error ?? "Failed to start checkout.");
        setLoading(null);
        return;
      }

      window.location.href = data.url;
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(null);
    }
  }

  // Team plan users have the highest tier — nothing to upgrade to
  if (currentPlan === "team") return null;

  return (
    <div className="flex items-center gap-3">
      {currentPlan === "free" && (
        <button
          onClick={() => handleUpgrade("pro")}
          disabled={loading !== null}
          className="rounded-lg bg-inari-accent px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-125 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading === "pro" ? "Redirecting..." : "Upgrade to Pro"}
        </button>
      )}

      {(currentPlan === "free" || currentPlan === "pro") && (
        <button
          onClick={() => handleUpgrade("team")}
          disabled={loading !== null}
          className="rounded-lg border border-violet-900/50 bg-violet-950/20 px-3 py-1.5 text-sm font-medium text-violet-400 transition-all hover:bg-violet-950/40 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading === "team" ? "Redirecting..." : "Upgrade to Team"}
        </button>
      )}

      {error && (
        <span className="text-sm text-red-400">{error}</span>
      )}
    </div>
  );
}
