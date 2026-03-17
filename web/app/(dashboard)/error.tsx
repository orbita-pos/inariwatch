"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center min-h-[60vh] px-6">
      <div className="text-center max-w-md">
        <div className="flex justify-center mb-6">
          <AlertTriangle className="h-10 w-10 text-inari-accent opacity-80" />
        </div>
        <h1 className="text-xl font-bold text-fg-strong mb-2">Something went wrong</h1>
        <p className="text-fg-base text-sm mb-6">
          An error occurred loading this page. Your data is safe.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button variant="primary" onClick={reset}>Try again</Button>
          <Link href="/dashboard">
            <Button variant="outline" className="w-full sm:w-auto">Go to dashboard</Button>
          </Link>
        </div>
        {error.digest && (
          <p className="mt-6 text-xs text-zinc-500 font-mono">Error ID: {error.digest}</p>
        )}
      </div>
    </div>
  );
}
