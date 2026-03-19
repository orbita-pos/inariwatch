"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { resetPassword } from "./actions";
import bgDesktopSrc from "@/public/login-new-3.png";
import bgMobileSrc from "@/public/login-side-mobile.png";

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
        
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100">
          <svg className="h-6 w-6 text-inari-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <div>
          <h2 className="text-base font-medium text-zinc-900">
            Password updated
          </h2>
          <p className="mt-2 text-sm text-zinc-500">
            You’re back under Inari’s watch.
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
      
      <p className="text-sm text-zinc-600">
        Set a new password for your account.
      </p>

      <input
        type="password"
        name="password"
        placeholder="New password"
        required
        minLength={8}
        className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-inari-accent/60 focus:outline-none focus:ring-2 focus:ring-inari-accent/20"
      />

      <input
        type="password"
        name="confirmPassword"
        placeholder="Confirm password"
        required
        minLength={8}
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
        {loading ? "Resetting…" : "Reset password"}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
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
            Set a new password
          </h1>

          <p className="mt-1.5 text-sm text-zinc-400">
            Inari will secure your account
          </p>
        </div>

        {/* Glass Card */}
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-[0_8px_40px_rgba(0,0,0,0.35)]">
          
          <Suspense fallback={<div className="h-40 animate-pulse bg-white/5 rounded-lg" />}>
            <ResetPasswordForm />
          </Suspense>

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