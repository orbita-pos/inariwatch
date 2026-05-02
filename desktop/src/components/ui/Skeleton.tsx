import { type HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

/**
 * Skeleton — S33 (2026-05-01). Replaces loading spinners across the app
 * (per `specs/linear-ux-reference/README.md` § Anti-patterns: "Loading
 * spinners — use skeleton loaders instead").
 *
 * Visual: low-contrast shimmer between `--card` and `--card-elevated`
 * driven by the `.skeleton-shimmer` keyframe in `globals.css`. Reduced-
 * motion users see a static `--card` block (the global media query
 * collapses `animation-duration` to 1ms).
 *
 * Usage:
 *   <Skeleton className="h-4 w-32" />
 *   <Skeleton className="h-10 w-full" />
 *
 * Compose with flex/grid for entire row skeletons; don't try to make
 * Skeleton "smart" about layout — let the parent handle positioning.
 */
export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {}

export function Skeleton({ className, ...rest }: SkeletonProps) {
  return (
    <div
      aria-hidden
      data-testid="skeleton"
      className={cn(
        "skeleton-shimmer rounded-[var(--radius-sm)]",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * SkeletonRow — convenience composition for list-row loaders.
 * Renders an avatar circle + two text bars to mimic an issue / alert row.
 */
export function SkeletonRow({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-3",
        className,
      )}
    >
      <Skeleton className="h-4 w-4 rounded-full shrink-0" />
      <div className="flex-1 flex flex-col gap-1.5 min-w-0">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-1/3 opacity-70" />
      </div>
      <Skeleton className="h-3 w-12 shrink-0 opacity-70" />
    </div>
  );
}
