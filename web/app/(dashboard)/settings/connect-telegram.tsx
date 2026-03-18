"use client";

import { useState, useTransition } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { MessageSquare, Plus, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { connectTelegram } from "./actions";

export function ConnectTelegramButton() {
  const [open, setOpen] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  function handleClose() {
    setOpen(false);
    setBotToken("");
    setChatId("");
    setError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await connectTelegram(botToken, chatId || undefined);
      if (res.error) {
        setError(res.error);
      } else {
        handleClose();
      }
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && handleClose()}>
      <Dialog.Trigger asChild>
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:border-zinc-600 hover:text-fg-base transition-all"
        >
          <Plus className="h-3.5 w-3.5" />
          Connect Telegram
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-6 shadow-2xl">
          <div className="flex items-center gap-2.5 mb-1">
            <MessageSquare className="h-4 w-4 text-zinc-500" />
            <Dialog.Title className="text-lg font-semibold text-fg-strong">
              Connect Telegram
            </Dialog.Title>
          </div>
          <Dialog.Description className="text-sm text-fg-base mb-6">
            Create a bot with <span className="text-fg-base">@BotFather</span> and paste your token below.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium text-fg-base">Bot token</label>
              <input
                type="text"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v..."
                autoFocus
                className="mt-1.5 h-10 w-full rounded-lg border border-line bg-surface-inner px-3 font-mono text-sm text-fg-strong placeholder:text-zinc-500 outline-none focus:border-inari-accent/40 focus:ring-1 focus:ring-inari-accent/20 transition-colors"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-fg-base">
                Chat ID <span className="text-zinc-500 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="Auto-detected if empty"
                className="mt-1.5 h-10 w-full rounded-lg border border-line bg-surface-inner px-3 font-mono text-sm text-fg-strong placeholder:text-zinc-500 outline-none focus:border-inari-accent/40 focus:ring-1 focus:ring-inari-accent/20 transition-colors"
              />
              <p className="mt-1 text-xs text-zinc-500">
                Send <span className="text-zinc-400">/start</span> to your bot first — we'll auto-detect the chat ID.
              </p>
            </div>

            {error && (
              <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400">{error}</p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={handleClose}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={!botToken.trim() || isPending}>
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect & test"}
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
