"use client";

import { useState } from "react";

interface UpgradeButtonProps {
  currentPlan: string;
}

export function UpgradeButton({ currentPlan }: UpgradeButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pro users have nothing to upgrade to
  if (currentPlan === "pro") return null;

  async function handleUpgrade() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      });

      const data = await res.json();

      if (!res.ok || !data.url) {
        setError(data.error ?? "Failed to start checkout.");
        setLoading(false);
        return;
      }

      window.location.href = data.url;
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleUpgrade}
        disabled={loading}
        className="rounded-lg bg-inari-accent px-3 py-1.5 text-sm font-medium text-white transition-all hover:brightness-125 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? "Redirecting..." : "Upgrade to Pro"}
      </button>

      {error && (
        <span className="text-sm text-red-400">{error}</span>
      )}
    </div>
  );
}
