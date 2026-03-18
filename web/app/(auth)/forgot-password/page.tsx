"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { requestPasswordReset } from "./actions";

export default function ForgotPasswordPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [sent, setSent]       = useState(false);

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
    <div className="relative flex min-h-screen items-center justify-center sm:justify-start bg-inari-bg">
      
      {/* Background */}
      <div className="absolute inset-0">
        <Image
          src="/login-new-3.png"
          alt=""
          fill
          className="hidden object-cover object-center sm:block"
          priority
        />
        <Image
          src="/login-side-mobile.png"
          alt=""
          fill
          className="block object-cover object-top sm:hidden"
          priority
        />
        <div className="absolute inset-0 bg-radial-fade" />
      </div>

      {/* Container */}
      <div className="relative w-full max-w-sm px-4 py-12 sm:ml-16 lg:ml-24 xl:ml-32">
        
        {/* Logo */}
        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex items-center gap-2.5">
            <Image
              src="/logo-inari/favicon-96x96.png"
              alt="InariWatch"
              width={36}
              height={36}
            />
            <span className="font-mono text-sm font-bold uppercase tracking-[0.15em] text-white">
              InariWatch
            </span>
          </Link>

          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-white">
            Reset your password
          </h1>

          <p className="mt-1.5 text-sm text-zinc-400">
            Inari will help you recover access
          </p>
        </div>

        {/* Glass Card */}
        <div className="rounded-2xl border border-white/20 bg-white/10 backdrop-blur-xl p-8 shadow-[0_0_80px_rgba(59,130,246,0.15)] transition-all duration-500 hover:shadow-[0_0_120px_rgba(59,130,246,0.25)]">
          
          {sent ? (
            <div className="space-y-4 text-center">
              
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-white/10">
                <svg className="h-6 w-6 text-inari-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>

              <div>
                <h2 className="text-base font-medium text-white">
                  Check your email
                </h2>

                <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
                  If an account exists, a reset link has been sent. It expires in 1 hour.
                </p>
              </div>

              <Link href="/login" className="inline-block text-sm text-inari-accent hover:brightness-125 transition-all">
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              
              <p className="text-sm text-zinc-400 leading-relaxed">
                Enter your email and Inari will send you a reset link.
              </p>

              <input
                type="email"
                name="email"
                placeholder="you@company.com"
                required
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-inari-accent/50 focus:outline-none focus:ring-1 focus:ring-inari-accent/30"
              />

              {error && (
                <p className="text-sm text-red-400 font-mono">{error}</p>
              )}

              <Button
                variant="primary"
                className="w-full mt-2"
                type="submit"
                disabled={loading}
              >
                {loading ? "Sending…" : "Send reset link"}
              </Button>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-zinc-500">
          Remember your password?{" "}
          <Link href="/login" className="text-zinc-300 hover:text-white">
            Sign in →
          </Link>
        </p>
      </div>
    </div>
  );
}