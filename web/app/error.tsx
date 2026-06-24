"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen bg-[#09090b] flex items-center justify-center px-6">
      <div className="text-center max-w-md">
        <div className="flex justify-center mb-6">
          <AlertTriangle className="h-12 w-12 text-[#7C3AED] opacity-80" />
        </div>
        <h1 className="text-2xl font-bold text-white mb-2">Something went wrong</h1>
        <p className="text-zinc-400 mb-8">
          An unexpected error occurred. Try refreshing the page.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button variant="primary" onClick={reset}>Try again</Button>
          <Link href="/">
            <Button variant="outline" className="w-full sm:w-auto">Go home</Button>
          </Link>
        </div>
        {error.digest && (
          <p className="mt-6 text-xs text-zinc-600 font-mono">Error ID: {error.digest}</p>
        )}
      </div>
    </div>
  );
}
