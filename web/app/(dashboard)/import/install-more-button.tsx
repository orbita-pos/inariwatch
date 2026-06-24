"use client";

import { ExternalLink } from "lucide-react";

export function InstallMoreButton({ slug }: { slug: string }) {
  return (
    <a
      href={`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line-medium bg-surface-dim px-3 py-1.5 text-[12px] text-fg-base hover:border-fg-base/30 transition-colors"
    >
      Add more repos on GitHub <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  );
}
