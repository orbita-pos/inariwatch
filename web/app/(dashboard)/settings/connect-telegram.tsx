"use client";

import { useState, useTransition } from "react";
import { MessageSquare, Plus, X, Loader2 } from "lucide-react";
import { connectTelegram } from "./actions";

export function ConnectTelegramButton() {
  const [open, setOpen] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  const handleSubmit = () => {
    setError(null);
    start(async () => {
      const res = await connectTelegram(botToken, chatId || undefined);
      if (res.error) {
        setError(res.error);
      } else {
        setOpen(false);
        setBotToken("");
        setChatId("");
      }
    });
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:border-zinc-600 hover:text-fg-base transition-all"
      >
        <Plus className="h-3.5 w-3.5" />
        Connect Telegram
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface-inner p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-zinc-500" />
          <span className="text-sm font-medium text-fg-base">Connect Telegram</span>
        </div>
        <button
          onClick={() => { setOpen(false); setError(null); }}
          className="text-zinc-600 hover:text-zinc-400 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-zinc-500">Bot token</label>
          <input
            type="text"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v..."
            className="w-full rounded-lg border border-line-medium bg-surface px-3 py-2 text-[13px] text-fg-base placeholder:text-zinc-800 focus:outline-none focus:border-zinc-600 font-mono"
          />
          <p className="text-[11px] text-zinc-700">
            Create a bot with <span className="text-zinc-500">@BotFather</span> on Telegram and paste the token here.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-zinc-500">Chat ID <span className="text-zinc-700">(optional)</span></label>
          <input
            type="text"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="Auto-detected if empty"
            className="w-full rounded-lg border border-line-medium bg-surface px-3 py-2 text-[13px] text-fg-base placeholder:text-zinc-800 focus:outline-none focus:border-zinc-600 font-mono"
          />
          <p className="text-[11px] text-zinc-700">
            Send <span className="text-zinc-500">/start</span> to your bot first. We'll auto-detect the chat ID, or enter it manually.
          </p>
        </div>
      </div>

      {error && (
        <p className="text-[12px] text-red-400">{error}</p>
      )}

      <button
        onClick={handleSubmit}
        disabled={!botToken.trim() || isPending}
        className="inline-flex items-center gap-1.5 rounded-lg border border-inari-accent/30 bg-inari-accent-dim px-3 py-1.5 text-[12px] font-medium text-inari-accent hover:bg-inari-accent/15 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isPending ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Connecting…
          </>
        ) : (
          "Connect & send test message"
        )}
      </button>
    </div>
  );
}
