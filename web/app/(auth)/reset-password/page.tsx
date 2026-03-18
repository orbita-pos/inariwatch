"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { resetPassword } from "./actions";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const formData = new FormData(e.currentTarget);
    formData.set("token", token ?? "");

    const result = await resetPassword(formData);

    if (result.error) {
      setError(result.error);
      setLoading(false);
    } else {
      setSuccess(true);
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-red-400">Invalid reset link.</p>
        <Link href="/forgot-password" className="text-inari-accent text-sm">
          Request a new link
        </Link>
      </div>
    );
  }

  if (success) {
    return (
      <div className="space-y-4 text-center">
        
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-white/10">
          <svg className="h-6 w-6 text-inari-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <div>
          <h2 className="text-base font-medium text-white">
            Password updated
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            You're back under Inari’s watch.
          </p>
        </div>

        <Link href="/login" className="text-inari-accent text-sm">
          Sign in →
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      
      <p className="text-sm text-zinc-400">
        Set a new password for your account.
      </p>

      <input
        type="password"
        name="password"
        placeholder="New password"
        required
        minLength={8}
        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-inari-accent/50 focus:outline-none focus:ring-1 focus:ring-inari-accent/30"
      />

      <input
        type="password"
        name="confirmPassword"
        placeholder="Confirm password"
        required
        minLength={8}
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
        {loading ? "Resetting…" : "Reset password"}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
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
            Set a new password
          </h1>

          <p className="mt-1.5 text-sm text-zinc-400">
            Inari will secure your account
          </p>
        </div>

        {/* Glass Card */}
        <div className="rounded-2xl border border-white/20 bg-white/10 backdrop-blur-xl p-8 shadow-[0_0_80px_rgba(59,130,246,0.15)] transition-all duration-500 hover:shadow-[0_0_120px_rgba(59,130,246,0.25)]">
          
          <Suspense fallback={<div className="h-40 animate-pulse bg-white/5 rounded-lg" />}>
            <ResetPasswordForm />
          </Suspense>

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