"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { addProjectFromRepo } from "./actions";

export function ImportRepoButton({
  installationId,
  owner,
  repo,
  alreadyAdded,
}: {
  installationId: number;
  owner: string;
  repo: string;
  alreadyAdded: boolean;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [status, setStatus] = useState<"idle" | "added" | "error">(
    alreadyAdded ? "added" : "idle",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (status === "added") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-green-500/20 bg-green-500/[0.05] px-2.5 py-1 text-[12px] font-medium text-green-600 dark:text-green-400">
        <Check className="h-3.5 w-3.5" /> Added
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {errorMsg && (
        <span className="text-[11px] text-red-500" title={errorMsg}>
          {errorMsg.slice(0, 32)}…
        </span>
      )}
      <Button
        variant="primary"
        size="sm"
        className="gap-1.5"
        disabled={isPending}
        onClick={() => {
          setErrorMsg(null);
          start(async () => {
            const r = await addProjectFromRepo(installationId, owner, repo);
            if (r.error) {
              setStatus("error");
              setErrorMsg(r.error);
              return;
            }
            setStatus("added");
            // Light refresh so the alreadyAdded flag flips for any other
            // copies of this repo in the list (paginated dupes etc.).
            router.refresh();
          });
        }}
      >
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        Add
      </Button>
    </div>
  );
}
