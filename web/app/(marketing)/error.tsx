"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

export default function MarketingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen bg-inari-bg flex items-center justify-center px-6">
      <div className="text-center max-w-md">
        <div className="flex justify-center mb-6">
          <AlertTriangle className="h-12 w-12 text-inari-accent opacity-80" />
        </div>
        <h1 className="text-2xl font-bold text-fg-strong mb-2">Something went wrong</h1>
        <p className="text-fg-base mb-8">
          We couldn&apos;t load this page. Try refreshing or go back to the homepage.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button variant="primary" onClick={reset}>Try again</Button>
          <Link href="/">
            <Button variant="outline" className="w-full sm:w-auto">Go home</Button>
          </Link>
        </div>
        {error.digest && (
          <p className="mt-6 text-xs text-zinc-500 font-mono">Error ID: {error.digest}</p>
        )}
      </div>
    </div>
  );
}
