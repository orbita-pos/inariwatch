"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { requestPasswordReset } from "./actions";
import bgDesktopSrc from "@/public/login-new-3.png";
import bgMobileSrc from "@/public/login-side-mobile.png";

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
    <div className="relative flex min-h-screen items-center justify-center sm:justify-start bg-zinc-900">
      
      {/* Background */}
      <div className="absolute inset-0">
        <Image
          src={bgDesktopSrc}
          alt=""
          fill
          className="hidden object-cover object-center sm:block"
          priority
          placeholder="blur"
          quality={85}
          sizes="100vw"
        />
        <Image
          src={bgMobileSrc}
          alt=""
          fill
          className="block object-cover object-top sm:hidden"
          priority
          placeholder="blur"
          quality={85}
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-black/50" />
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
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-[0_8px_40px_rgba(0,0,0,0.35)]">
          
          {sent ? (
            <div className="space-y-4 text-center">
              
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100">
                <svg className="h-6 w-6 text-inari-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>

              <div>
                <h2 className="text-base font-medium text-zinc-900">
                  Check your email
                </h2>

                <p className="mt-2 text-sm text-zinc-500 leading-relaxed">
                  If an account exists, a reset link has been sent. It expires in 1 hour.
                </p>
              </div>

              <Link href="/login" className="inline-block text-sm text-inari-accent hover:brightness-125 transition-all">
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              
              <p className="text-sm text-zinc-600 leading-relaxed">
                Enter your email and Inari will send you a reset link.
              </p>

              <input
                type="email"
                name="email"
                placeholder="you@company.com"
                required
                className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-inari-accent/60 focus:outline-none focus:ring-2 focus:ring-inari-accent/20"
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

        <p className="mt-6 text-center text-sm text-white/70">
          Remember your password?{" "}
          <Link href="/login" className="text-white hover:text-white/80 font-medium">
            Sign in →
          </Link>
        </p>
      </div>
    </div>
  );
}