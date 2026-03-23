"use client";

import { useState, useTransition } from "react";
import { Trash2, Loader2 } from "lucide-react";
import { deletePost } from "./actions";
import { useRouter } from "next/navigation";

export function DeletePostButton({ id, title }: { id: string; title: string }) {
  const [confirm, setConfirm] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  if (!confirm) {
    return (
      <button
        onClick={() => setConfirm(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-600 hover:text-red-400 hover:border-red-900/50 transition-colors"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-zinc-500">Delete?</span>
      <button
        onClick={() => {
          startTransition(async () => {
            await deletePost(id);
            router.refresh();
          });
        }}
        disabled={isPending}
        className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
      >
        {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Yes"}
      </button>
      <button
        onClick={() => setConfirm(false)}
        className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
      >
        No
      </button>
    </div>
  );
}
