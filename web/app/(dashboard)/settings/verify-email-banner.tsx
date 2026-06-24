"use client";

import { useState } from "react";
import { resendVerificationEmail } from "./verification-actions";

interface VerifyEmailBannerProps {
  hasPassword: boolean;
  emailVerifiedAt: Date | null;
}

export function VerifyEmailBanner({ hasPassword, emailVerifiedAt }: VerifyEmailBannerProps) {
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  // Only show for credentials users (have passwordHash) without verified email
  if (!hasPassword || emailVerifiedAt) return null;

  const handleResend = async () => {
    setLoading(true);
    setError("");
    setSent(false);

    const result = await resendVerificationEmail();

    if (result.error) {
      setError(result.error);
    } else {
      setSent(true);
    }
    setLoading(false);
  };

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
          <svg className="h-5 w-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">Please verify your email</p>
          <p className="mt-1 text-sm text-amber-600/80 dark:text-amber-300/60">
            Check your inbox for a verification link, or click below to resend.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={handleResend}
              disabled={loading || sent}
              className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-sm font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Sending..." : sent ? "Email sent" : "Resend verification email"}
            </button>
            {sent && (
              <span className="text-xs text-amber-600/70 dark:text-amber-300/60">Check your inbox</span>
            )}
            {error && (
              <span className="text-xs text-red-600 dark:text-red-400" role="alert">{error}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
