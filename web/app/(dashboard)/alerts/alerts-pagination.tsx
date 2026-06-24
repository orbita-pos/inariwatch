"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function AlertsPagination({ page, totalPages }: { page: number; totalPages: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const goToPage = useCallback(
    (p: number) => {
      const params = new URLSearchParams(searchParams.toString());
      if (p <= 1) {
        params.delete("page");
      } else {
        params.set("page", String(p));
      }
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, searchParams],
  );

  return (
    <div className="flex items-center justify-between">
      <p className="text-xs tabular-nums text-fg-base/70">
        Page {page} of {totalPages}
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => goToPage(page - 1)}
          disabled={page <= 1}
          className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg-base transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.03] disabled:pointer-events-none disabled:opacity-40"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Previous
        </button>
        <button
          onClick={() => goToPage(page + 1)}
          disabled={page >= totalPages}
          className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg-base transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.03] disabled:pointer-events-none disabled:opacity-40"
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
