"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState, useTransition } from "react";
import { X, FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createProject } from "../projects/actions";

export function CreateProjectModal({ children }: { children: React.ReactNode }) {
  const [open, setOpen]    = useState(false);
  const [error, setError]  = useState("");
  const [isPending, start] = useTransition();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const formData = new FormData(e.currentTarget);
    start(async () => {
      const result = await createProject(formData);
      if (result.error) setError(result.error);
      else setOpen(false);
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { setOpen(v); setError(""); }}>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />

        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-inari-border bg-inari-card p-6 shadow-[0_0_60px_rgba(0,0,0,0.6)] focus:outline-none">
          <div className="flex items-center justify-between mb-6">
            <div>
              <Dialog.Title className="text-base font-semibold text-white">
                New project
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-zinc-500">
                A project groups your integrations and alerts together.
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-mono text-zinc-500 uppercase tracking-wider mb-1.5">
                Project name
              </label>
              <input
                name="name"
                type="text"
                placeholder="my-app"
                required
                autoFocus
                className="w-full rounded-lg border border-inari-border bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/50 focus:outline-none focus:ring-1 focus:ring-inari-accent/30 transition-colors"
              />
              <p className="mt-1 text-xs text-zinc-600">
                The slug is auto-generated from the name.
              </p>
            </div>

            <div>
              <label className="block text-xs font-mono text-zinc-500 uppercase tracking-wider mb-1.5">
                Description <span className="normal-case text-zinc-700">(optional)</span>
              </label>
              <input
                name="description"
                type="text"
                placeholder="Production Next.js app"
                className="w-full rounded-lg border border-inari-border bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/50 focus:outline-none focus:ring-1 focus:ring-inari-accent/30 transition-colors"
              />
            </div>

            {error && <p className="text-xs text-red-400 font-mono">{error}</p>}

            <div className="flex gap-3 pt-2">
              <Dialog.Close asChild>
                <Button variant="outline" className="flex-1" type="button">Cancel</Button>
              </Dialog.Close>
              <Button variant="primary" className="flex-1" type="submit" disabled={isPending}>
                {isPending ? "Creating…" : "Create project"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
