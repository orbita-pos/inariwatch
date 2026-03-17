"use client";

import { useState, useTransition } from "react";
import { Mail, Plus, X, Loader2 } from "lucide-react";
import { sendEmailCode, verifyEmailCode } from "./actions";

export function ConnectEmailButton() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  const handleSendCode = () => {
    setError(null);
    start(async () => {
      const res = await sendEmailCode(email);
      if (res.error) {
        setError(res.error);
      } else {
        setStep("code");
      }
    });
  };

  const handleVerify = () => {
    setError(null);
    start(async () => {
      const res = await verifyEmailCode(code);
      if (res.error) {
        setError(res.error);
      } else {
        setOpen(false);
        setEmail("");
        setCode("");
        setStep("email");
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
        Connect Email
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface-inner p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-zinc-500" />
          <span className="text-sm font-medium text-fg-base">Connect Email</span>
        </div>
        <button
          onClick={() => { setOpen(false); setError(null); setStep("email"); }}
          className="text-zinc-600 hover:text-zinc-400 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {step === "email" ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-zinc-500">Email address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-lg border border-line-medium bg-surface px-3 py-2 text-[13px] text-fg-base placeholder:text-zinc-800 focus:outline-none focus:border-zinc-600"
              onKeyDown={(e) => e.key === "Enter" && email.includes("@") && handleSendCode()}
            />
            <p className="text-[11px] text-zinc-700">
              We'll send a verification code to this address.
            </p>
          </div>

          {error && <p className="text-[12px] text-red-400">{error}</p>}

          <button
            onClick={handleSendCode}
            disabled={!email.includes("@") || isPending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-inari-accent/30 bg-inari-accent-dim px-3 py-1.5 text-[12px] font-medium text-inari-accent hover:bg-inari-accent/15 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Sending…
              </>
            ) : (
              "Send verification code"
            )}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-zinc-500">Verification code</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              maxLength={6}
              className="w-full rounded-lg border border-line-medium bg-surface px-3 py-2 text-[13px] text-fg-base placeholder:text-zinc-800 focus:outline-none focus:border-zinc-600 font-mono tracking-widest text-center text-lg"
              onKeyDown={(e) => e.key === "Enter" && code.length === 6 && handleVerify()}
            />
            <p className="text-[11px] text-zinc-700">
              Enter the 6-digit code sent to <span className="text-zinc-500">{email}</span>
            </p>
          </div>

          {error && <p className="text-[12px] text-red-400">{error}</p>}

          <div className="flex items-center gap-2">
            <button
              onClick={handleVerify}
              disabled={code.length !== 6 || isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-inari-accent/30 bg-inari-accent-dim px-3 py-1.5 text-[12px] font-medium text-inari-accent hover:bg-inari-accent/15 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Verifying…
                </>
              ) : (
                "Verify & connect"
              )}
            </button>
            <button
              onClick={() => { setStep("email"); setCode(""); setError(null); }}
              className="text-[12px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              Change email
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
