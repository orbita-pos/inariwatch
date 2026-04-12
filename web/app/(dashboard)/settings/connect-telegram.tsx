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
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-fg-base/60 hover:border-fg-base/30 hover:text-fg-base transition-all"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Connect Telegram
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-6 shadow-2xl">
          <div className="flex items-center gap-2.5 mb-1">
            <MessageSquare className="h-4 w-4 text-fg-base/50" aria-hidden="true" />
            <Dialog.Title className="text-lg font-semibold text-fg-strong">
              Connect Telegram
            </Dialog.Title>
          </div>
          <Dialog.Description className="text-sm text-fg-base mb-6">
            Create a bot with <span className="text-fg-base">@BotFather</span> and paste your token below.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="tg-bot-token" className="text-sm font-medium text-fg-base">Bot token</label>
              <input
                id="tg-bot-token"
                type="text"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v..."
                autoFocus
                className="mt-1.5 h-10 w-full rounded-lg border border-line bg-surface-inner px-3 font-mono text-sm text-fg-strong placeholder:text-fg-base/40 outline-none focus:border-inari-accent/40 focus:ring-1 focus:ring-inari-accent/20 transition-colors"
              />
            </div>

            <div>
              <label htmlFor="tg-chat-id" className="text-sm font-medium text-fg-base">
                Chat ID <span className="text-fg-base/60 font-normal">(optional)</span>
              </label>
              <input
                id="tg-chat-id"
                type="text"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="Auto-detected if empty"
                className="mt-1.5 h-10 w-full rounded-lg border border-line bg-surface-inner px-3 font-mono text-sm text-fg-strong placeholder:text-fg-base/40 outline-none focus:border-inari-accent/40 focus:ring-1 focus:ring-inari-accent/20 transition-colors"
              />
              <p className="mt-1 text-xs text-fg-base/60">
                Send <span className="text-fg-base/50 font-mono">/start</span> to your bot first — we'll auto-detect the chat ID.
              </p>
            </div>

            {error && (
              <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={handleClose}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={!botToken.trim() || isPending}>
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : "Connect & test"}
              </Button>
            </div>
          </form>

          <Dialog.Close asChild>
            <button type="button" className="absolute right-4 top-4 text-fg-base/60 hover:text-fg-strong transition-colors" aria-label="Close">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
