"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback } from "react";

interface Props {
  page: number;
  totalPages: number;
}

export function ReplaysPagination({ page, totalPages }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const goto = useCallback((target: number) => {
    const params = new URLSearchParams(searchParams.toString());
    if (target <= 1) params.delete("page");
    else params.set("page", String(target));
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }, [router, pathname, searchParams]);

  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;

  return (
    <div className="flex items-center justify-between">
      <button
        type="button"
        onClick={() => goto(page - 1)}
        disabled={prevDisabled}
        className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-fg-base hover:text-fg-strong disabled:opacity-40 disabled:cursor-not-allowed"
      >
        ← Previous
      </button>
      <span className="text-xs text-fg-base/60">
        Page {page} of {totalPages}
      </span>
      <button
        type="button"
        onClick={() => goto(page + 1)}
        disabled={nextDisabled}
        className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-fg-base hover:text-fg-strong disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Next →
      </button>
    </div>
  );
}
