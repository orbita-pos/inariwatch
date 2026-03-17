"use client";

import { useState, useTransition } from "react";
import { Sparkles, Trash2, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { saveAIKey, deleteAIKey } from "./ai-key-actions";

interface Props {
  hasKey: boolean;
  provider: string | null;
}

export function AIKeySection({ hasKey, provider }: Props) {
  const [showForm, setShowForm] = useState(!hasKey);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");
  const [isPending, start] = useTransition();

  const detectedProvider = key.startsWith("sk-ant-")
    ? "Claude (Anthropic)"
    : key.startsWith("sk-")
    ? "OpenAI"
    : null;

  const handleSave = () => {
    if (!key.trim()) return;
    setError("");
    start(async () => {
      const result = await saveAIKey(key.trim());
      if (result?.error) {
        setError(result.error);
      } else {
        setKey("");
        setShowForm(false);
      }
    });
  };

  const handleDelete = () => {
    start(async () => {
      await deleteAIKey();
      setShowForm(true);
    });
  };

  if (hasKey && !showForm) {
    return (
      <div className="py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#222] bg-[#111]">
            <Sparkles className="h-4 w-4 text-inari-accent" />
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-300">
              {provider === "claude" ? "Claude (Anthropic)" : "OpenAI"} key connected
            </p>
            <p className="text-xs text-zinc-600">
              AI analysis and correlation are active
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
            Replace
          </Button>
          <button
            onClick={handleDelete}
            disabled={isPending}
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/[0.06] transition-colors"
            title="Remove AI key"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#222] bg-[#111] mt-0.5">
          <Sparkles className="h-4 w-4 text-zinc-600" />
        </div>
        <div>
          <p className="text-sm font-medium text-zinc-300">AI analysis key</p>
          <p className="mt-0.5 text-xs text-zinc-600">
            Paste a Claude (<span className="font-mono">sk-ant-…</span>) or OpenAI (
            <span className="font-mono">sk-…</span>) key. Used for alert root cause
            analysis and correlation. Your key is stored securely and never shared.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="relative">
          <input
            type={showKey ? "text" : "password"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-api03-… or sk-proj-…"
            className="w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2.5 pr-10 font-mono text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>

        {key.length > 0 && (
          <p className="text-xs text-zinc-600">
            {detectedProvider
              ? <span className="text-green-500">✓ Detected: {detectedProvider}</span>
              : <span className="text-amber-500">Unrecognized key format</span>
            }
          </p>
        )}

        {error && (
          <p className="text-xs text-red-400 font-mono">{error}</p>
        )}
      </div>

      <div className="flex gap-2">
        {hasKey && (
          <Button variant="outline" size="sm" onClick={() => { setShowForm(false); setKey(""); setError(""); }}>
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={isPending || !key.trim()}
        >
          {isPending ? "Saving…" : "Save key"}
        </Button>
      </div>
    </div>
  );
}
