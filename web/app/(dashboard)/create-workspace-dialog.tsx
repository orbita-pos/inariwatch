"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createOrganization } from "./workspace-actions";

interface CreateWorkspaceDialogProps {
  open:    boolean;
  onClose: () => void;
}

export function CreateWorkspaceDialog({ open, onClose }: CreateWorkspaceDialogProps) {
  const router = useRouter();
  const [name,  setName]  = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    startTransition(async () => {
      const result = await createOrganization(name);
      if (result.error) {
        setError(result.error);
      } else {
        setName("");
        onClose();
        router.refresh();
      }
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-6 shadow-2xl">
          <Dialog.Title className="text-lg font-semibold text-fg-strong">
            Create workspace
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-base">
            Workspaces let your team share projects, alerts, and integrations.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="ws-name" className="text-sm font-medium text-fg-base">Workspace name</label>
              <input
                id="ws-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Corp"
                autoFocus
                className="mt-1.5 h-10 w-full rounded-lg border border-line bg-surface-inner px-3 text-sm text-fg-strong placeholder:text-zinc-500 outline-none focus:border-inari-accent/40 focus:ring-1 focus:ring-inari-accent/20 transition-colors"
              />
            </div>

            {error && (
              <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400">{error}</p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={pending || name.trim().length < 2}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create workspace"}
              </Button>
            </div>
          </form>

          <Dialog.Close asChild>
            <button className="absolute right-4 top-4 text-zinc-500 hover:text-fg-strong transition-colors" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
