"use client";

import { useState, useTransition } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Mail, Plus, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { sendEmailCode, verifyEmailCode } from "./actions";

export function ConnectEmailButton() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  function handleClose() {
    setOpen(false);
    setEmail("");
    setCode("");
    setStep("email");
    setError(null);
  }

  function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await sendEmailCode(email);
      if (res.error) setError(res.error);
      else setStep("code");
    });
  }

  function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await verifyEmailCode(code);
      if (res.error) setError(res.error);
      else handleClose();
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
          Connect Email
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-6 shadow-2xl">
          <div className="flex items-center gap-2.5 mb-1">
            <Mail className="h-4 w-4 text-fg-base/50" aria-hidden="true" />
            <Dialog.Title className="text-lg font-semibold text-fg-strong">
              Connect Email
            </Dialog.Title>
          </div>
          <Dialog.Description className="text-sm text-fg-base mb-6">
            {step === "email"
              ? "We'll send a verification code to confirm your address."
              : `Enter the 6-digit code sent to ${email}.`}
          </Dialog.Description>

          {step === "email" ? (
            <form onSubmit={handleSendCode} className="space-y-4">
              <div>
                <label htmlFor="email-channel-addr" className="text-sm font-medium text-fg-base">Email address</label>
                <input
                  id="email-channel-addr"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoFocus
                  className="mt-1.5 h-10 w-full rounded-lg border border-line bg-surface-inner px-3 text-sm text-fg-strong placeholder:text-fg-base/40 outline-none focus:border-inari-accent/40 focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                />
              </div>

              {error && (
                <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={handleClose}>Cancel</Button>
                <Button type="submit" variant="primary" disabled={!email.includes("@") || isPending}>
                  {isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : "Send code"}
                </Button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleVerify} className="space-y-4">
              <div>
                <label htmlFor="email-verify-code" className="text-sm font-medium text-fg-base">Verification code</label>
                <input
                  id="email-verify-code"
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="123456"
                  maxLength={6}
                  autoFocus
                  className="mt-1.5 h-12 w-full rounded-lg border border-line bg-surface-inner px-3 text-center font-mono text-xl tracking-[0.5em] text-fg-strong placeholder:text-fg-base/40 outline-none focus:border-inari-accent/40 focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                />
              </div>

              {error && (
                <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => { setStep("email"); setCode(""); setError(null); }}>
                  Change email
                </Button>
                <Button type="submit" variant="primary" disabled={code.length !== 6 || isPending}>
                  {isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : "Verify & connect"}
                </Button>
              </div>
            </form>
          )}

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
