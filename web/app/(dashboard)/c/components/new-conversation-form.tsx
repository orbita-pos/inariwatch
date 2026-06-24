"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function NewConversationForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { conversation: { id: string } };
      router.push(`/c/${json.conversation.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What do you want to talk about?"
        maxLength={200}
        className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent focus:outline-none focus:ring-1 focus:ring-inari-accent"
      />
      <button
        type="submit"
        disabled={busy || !title.trim()}
        className="rounded-lg bg-inari-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-inari-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Creating…" : "Start conversation"}
      </button>
      {error ? <p className="text-xs text-inari-accent">{error}</p> : null}
    </form>
  );
}
