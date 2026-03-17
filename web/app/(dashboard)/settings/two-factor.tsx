"use client";

import { useState, useTransition } from "react";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { enableTwoFactor, disableTwoFactor, verifyTwoFactor } from "./two-factor-actions";

interface Props {
  enabled: boolean;
}

export function TwoFactorSection({ enabled }: Props) {
  const [step, setStep] = useState<"idle" | "setup" | "verify">("idle");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [isPending, start] = useTransition();

  const handleEnable = () => {
    setError("");
    start(async () => {
      const result = await enableTwoFactor();
      if (result.error) {
        setError(result.error);
        return;
      }
      setQrDataUrl(result.qrDataUrl ?? "");
      setSecret(result.secret ?? "");
      setStep("verify");
    });
  };

  const handleVerify = () => {
    if (code.length !== 6) {
      setError("Enter a 6-digit code");
      return;
    }
    setError("");
    start(async () => {
      const result = await verifyTwoFactor(code);
      if (result.error) {
        setError(result.error);
        return;
      }
      setStep("idle");
      setCode("");
      setQrDataUrl("");
      setSecret("");
    });
  };

  const handleDisable = () => {
    setError("");
    start(async () => {
      await disableTwoFactor();
    });
  };

  if (enabled && step === "idle") {
    return (
      <div className="flex items-center justify-between py-3">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-4 w-4 text-green-400" />
          <div>
            <p className="text-sm text-zinc-300">Two-factor authentication is enabled</p>
            <p className="text-xs text-zinc-600">Your account is protected with TOTP</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={handleDisable} disabled={isPending}>
          {isPending ? "Disabling…" : "Disable 2FA"}
        </Button>
      </div>
    );
  }

  if (step === "verify") {
    return (
      <div className="space-y-4 py-3">
        <div className="flex items-start gap-3">
          <ShieldCheck className="h-4 w-4 text-inari-accent mt-0.5" />
          <div>
            <p className="text-sm font-medium text-zinc-300">Set up authenticator app</p>
            <p className="mt-0.5 text-xs text-zinc-600">
              Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)
            </p>
          </div>
        </div>

        {qrDataUrl && (
          <div className="flex justify-center">
            <div className="rounded-xl border border-[#1a1a1a] bg-white p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrDataUrl} alt="QR Code" width={200} height={200} />
            </div>
          </div>
        )}

        {secret && (
          <div className="rounded-lg border border-[#1a1a1a] bg-[#080808] px-4 py-2.5">
            <p className="text-xs text-zinc-600 mb-1">Or enter this secret manually:</p>
            <p className="font-mono text-sm text-zinc-300 select-all break-all">{secret}</p>
          </div>
        )}

        <div className="space-y-2">
          <label className="text-xs text-zinc-500">Enter the 6-digit code from your app</label>
          <div className="flex gap-2">
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="000000"
              className="w-32 rounded-lg border border-[#222] bg-[#111] px-3 py-2 text-center font-mono text-lg text-zinc-100 tracking-widest placeholder-zinc-700 focus:border-inari-accent/40 focus:outline-none"
            />
            <Button variant="primary" size="sm" onClick={handleVerify} disabled={isPending}>
              {isPending ? "Verifying…" : "Verify & Enable"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setStep("idle"); setError(""); }}>
              Cancel
            </Button>
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-400 font-mono">{error}</p>
        )}
      </div>
    );
  }

  // idle, not enabled
  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex items-center gap-3">
        <ShieldOff className="h-4 w-4 text-zinc-600" />
        <div>
          <p className="text-sm text-zinc-300">Two-factor authentication</p>
          <p className="text-xs text-zinc-600">Add an extra layer of security to your account</p>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={handleEnable} disabled={isPending}>
        {isPending ? "Setting up…" : "Enable 2FA"}
      </Button>
    </div>
  );
}
