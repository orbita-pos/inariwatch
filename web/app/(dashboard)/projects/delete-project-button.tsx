"use client";

import { useState, useTransition } from "react";
import { Trash2, Loader2, X } from "lucide-react";
import { deleteProject } from "./actions";

interface Props {
  projectId:   string;
  projectName: string;
}

export function DeleteProjectButton({ projectId, projectName }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      await deleteProject(projectId);
    });
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={`Delete project ${projectName}`}
        title={`Delete ${projectName}`}
        className="flex h-7 w-7 items-center justify-center rounded-md text-fg-base/70 transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-labelledby={`delete-confirm-${projectId}`}
      className="flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1"
    >
      <span
        id={`delete-confirm-${projectId}`}
        className="text-[11px] font-medium text-red-600 dark:text-red-400 mr-1"
      >
        Delete {projectName}?
      </span>
      <button
        type="button"
        onClick={handleDelete}
        disabled={isPending}
        className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-60 dark:bg-red-500 dark:hover:bg-red-600 transition-colors"
      >
        {isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        ) : null}
        Delete
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={isPending}
        aria-label="Cancel delete"
        className="flex h-5 w-5 items-center justify-center rounded text-fg-base/70 hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
}
