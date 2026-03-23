"use client";

import { useState, useTransition } from "react";
import { Loader2, Mail, CheckCircle2 } from "lucide-react";
import { subscribeToNewsletter } from "./subscribe-action";

export function SubscribeForm({ compact = false }: { compact?: boolean }) {
  const [email, setEmail] = useState("");
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<"idle" | "ok" | "already" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = await subscribeToNewsletter(email);
      if (result.error) {
        setState("error");
        setErrorMsg(result.error);
      } else if (result.alreadySubscribed) {
        setState("already");
      } else {
        setState("ok");
        setEmail("");
      }
    });
  }

  if (state === "ok") {
    return (
      <div className="flex items-center gap-2 text-emerald-400">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span className={compact ? "text-sm" : "text-base"}>
          You're subscribed! We'll notify you when new posts drop.
        </span>
      </div>
    );
  }

  if (state === "already") {
    return (
      <div className="flex items-center gap-2 text-zinc-400">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-zinc-500" />
        <span className={compact ? "text-sm" : "text-base"}>
          You're already subscribed.
        </span>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className={`flex gap-2 ${compact ? "flex-col sm:flex-row" : "flex-col sm:flex-row"}`}>
        <div className="relative flex-1">
          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-600 pointer-events-none" />
          <input
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setState("idle"); }}
            placeholder="your@email.com"
            required
            className={`w-full rounded-lg border border-inari-border bg-inari-card pl-9 pr-4 text-white placeholder-zinc-600 focus:border-inari-accent focus:outline-none transition-colors ${compact ? "py-2 text-sm" : "py-2.5 text-sm"}`}
          />
        </div>
        <button
          type="submit"
          disabled={isPending}
          className={`shrink-0 inline-flex items-center justify-center gap-2 rounded-lg bg-inari-accent font-medium text-white hover:bg-inari-accent/90 disabled:opacity-50 transition-colors ${compact ? "px-4 py-2 text-sm" : "px-5 py-2.5 text-sm"}`}
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Subscribe
        </button>
      </div>
      {state === "error" && (
        <p className="mt-2 text-xs text-red-400">{errorMsg}</p>
      )}
    </form>
  );
}
