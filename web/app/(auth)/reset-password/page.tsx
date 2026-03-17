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
        <p className="text-sm text-red-400">Invalid reset link. The token is missing.</p>
        <Link href="/forgot-password" className="inline-block text-sm text-inari-accent hover:brightness-125 transition-all">
          Request a new reset link
        </Link>
      </div>
    );
  }

  if (success) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-950/30">
          <svg className="h-6 w-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <div>
          <h2 className="text-base font-medium text-white">Password updated</h2>
          <p className="mt-2 text-sm text-zinc-500">
            Your password has been reset. You can now sign in.
          </p>
        </div>
        <Link href="/login" className="inline-block text-sm text-inari-accent hover:brightness-125 transition-all">
          Sign in →
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-zinc-400 leading-relaxed">Choose a new password for your account.</p>
      <div>
        <label className="block text-xs font-mono text-zinc-500 uppercase tracking-wider mb-1.5">
          New password
        </label>
        <input
          type="password"
          name="password"
          placeholder="At least 8 characters"
          required
          minLength={8}
          className="w-full rounded-lg border border-inari-border bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/50 focus:outline-none focus:ring-1 focus:ring-inari-accent/30 transition-colors"
        />
      </div>
      <div>
        <label className="block text-xs font-mono text-zinc-500 uppercase tracking-wider mb-1.5">
          Confirm password
        </label>
        <input
          type="password"
          name="confirmPassword"
          placeholder="Repeat your password"
          required
          minLength={8}
          className="w-full rounded-lg border border-inari-border bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/50 focus:outline-none focus:ring-1 focus:ring-inari-accent/30 transition-colors"
        />
      </div>

      {error && <p className="text-sm text-red-400 font-mono">{error}</p>}

      <Button variant="primary" className="w-full mt-2" type="submit" disabled={loading}>
        {loading ? "Resetting…" : "Reset password"}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="relative flex min-h-screen items-center justify-center sm:justify-end bg-inari-bg">
      {/* Full-bleed background image */}
      <div className="absolute inset-0">
        <Image
          src="/login-side.png"
          alt=""
          fill
          className="hidden object-cover object-center sm:block"
          priority
          quality={100}
        />
        <Image
          src="/login-side-mobile.png"
          alt=""
          fill
          className="block object-cover object-top sm:hidden"
          priority
          quality={90}
        />
        <div className="absolute inset-0 bg-radial-fade" />
      </div>

      <div className="relative w-full max-w-sm px-4 py-12 sm:mr-16 lg:mr-24 xl:mr-32">
        {/* Logo */}
        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex items-center gap-2.5">
            <Image
              src="/logo-inari/favicon-96x96.png"
              alt="InariWatch"
              width={36}
              height={36}
              className="shrink-0"
            />
            <span className="font-mono text-sm font-bold uppercase tracking-[0.15em] text-white">
              InariWatch
            </span>
          </Link>
          <h1 className="mt-4 text-xl font-semibold text-white">Set a new password</h1>
          <p className="mt-1.5 text-sm text-zinc-500">Almost there</p>
        </div>

        <div className="rounded-2xl border border-inari-border bg-inari-card/90 backdrop-blur-sm p-8 shadow-[0_0_50px_rgba(0,0,0,0.5)]">
          <Suspense fallback={<div className="h-48 animate-pulse rounded-lg bg-zinc-900" />}>
            <ResetPasswordForm />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-sm text-zinc-600">
          Remember your password?{" "}
          <Link href="/login" className="text-zinc-400 hover:text-white transition-colors">
            Sign in →
          </Link>
        </p>
      </div>
    </div>
  );
}
