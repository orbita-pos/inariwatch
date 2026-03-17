"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { requestPasswordReset } from "./actions";

export default function ForgotPasswordPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const formData = new FormData(e.currentTarget);
    const result = await requestPasswordReset(formData);

    if (result.error) {
      setError(result.error);
      setLoading(false);
    } else {
      setSent(true);
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-inari-bg px-4">
      {/* Background glow */}
      <div className="absolute inset-0 bg-radial-fade pointer-events-none" />

      <div className="relative w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex items-center gap-2.5 font-mono text-xl font-bold">
            <span className="inari-dot text-inari-accent glow-accent-text">&#9673;</span>
            <span className="text-white uppercase tracking-widest text-sm">KAIRO</span>
          </Link>
          <p className="mt-3 text-sm text-zinc-500">Reset your password</p>
        </div>

        <div className="rounded-2xl border border-inari-border bg-inari-card p-8 shadow-[0_0_50px_rgba(0,0,0,0.5)]">
          {sent ? (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-inari-accent/10">
                <svg className="h-6 w-6 text-inari-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <div>
                <h2 className="text-base font-medium text-white">Check your email</h2>
                <p className="mt-2 text-sm text-zinc-500 leading-relaxed">
                  If an account exists with that email, we sent a password reset link. It expires in 1 hour.
                </p>
              </div>
              <Link
                href="/login"
                className="inline-block text-sm text-inari-accent hover:brightness-125 transition-all"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-sm text-zinc-400 leading-relaxed">
                Enter the email address associated with your account and we&apos;ll send you a link to reset your password.
              </p>

              <div>
                <label className="block text-xs font-mono text-zinc-500 uppercase tracking-wider mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  name="email"
                  placeholder="you@company.com"
                  required
                  className="w-full rounded-lg border border-inari-border bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/50 focus:outline-none focus:ring-1 focus:ring-inari-accent/30 transition-colors"
                />
              </div>

              {error && (
                <p className="text-sm text-red-400 font-mono">{error}</p>
              )}

              <Button
                variant="primary"
                className="w-full mt-2"
                type="submit"
                disabled={loading}
              >
                {loading ? "Sending..." : "Send reset link"}
              </Button>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-zinc-600">
          Remember your password?{" "}
          <Link href="/login" className="text-zinc-400 hover:text-white transition-colors">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
