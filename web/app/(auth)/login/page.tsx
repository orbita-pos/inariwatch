"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import loginSideSrc from "@/public/login-side.png";
import loginSideMobileSrc from "@/public/login-side-mobile.png";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp]         = useState("");
  const [needs2FA, setNeeds2FA] = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const result = await signIn("credentials", {
      email,
      password,
      totp: needs2FA ? totp : "",
      callbackUrl: "/dashboard",
      redirect: false,
    });

    if (result?.error) {
      if (result.error.includes("2FA_REQUIRED")) {
        setNeeds2FA(true);
        setError("");
      } else if (result.error.includes("INVALID_2FA")) {
        setError("Invalid 2FA code. Try again.");
      } else {
        setError("Invalid email or password.");
      }
      setLoading(false);
    } else if (result?.url) {
      window.location.href = result.url;
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center sm:justify-end bg-inari-bg">
      {/* Full-bleed background image */}
      <div className="absolute inset-0">
        <Image
          src={loginSideSrc}
          alt=""
          fill
          className="hidden object-cover object-center sm:block"
          priority
          placeholder="blur"
          quality={85}
          sizes="100vw"
        />
        <Image
          src={loginSideMobileSrc}
          alt=""
          fill
          className="block object-cover object-top sm:hidden"
          priority
          placeholder="blur"
          quality={85}
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-radial-fade" />
      </div>

      {/* Form floating on top */}
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
          <h1 className="mt-4 text-xl font-semibold text-white">Welcome back</h1>
          <p className="mt-1.5 text-sm text-zinc-500">Sign in to your dashboard</p>
        </div>

        <div className="rounded-2xl border border-inari-border bg-inari-card/90 backdrop-blur-sm p-8 shadow-[0_0_50px_rgba(0,0,0,0.5)]">
          {/* OAuth providers */}
          <div className="space-y-2">
            <Button
              variant="outline"
              className="w-full"
              onClick={() => signIn("github", { callbackUrl: "/dashboard" })}
            >
              <Github className="h-4 w-4" />
              Continue with GitHub
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Continue with Google
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => signIn("gitlab", { callbackUrl: "/dashboard" })}
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51a.42.42 0 01.82 0l2.44 7.51h8.06l2.44-7.51a.42.42 0 01.82 0l2.44 7.51 1.22 3.78a.84.84 0 01-.3.94z"/>
              </svg>
              Continue with GitLab
            </Button>
          </div>

          <div className="my-6 flex items-center gap-3">
            <div className="flex-1 h-px bg-inari-border" />
            <span className="text-xs text-zinc-700 font-mono">or</span>
            <div className="flex-1 h-px bg-inari-border" />
          </div>

          {/* Email / password */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-mono text-zinc-500 uppercase tracking-wider mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                className="w-full rounded-lg border border-inari-border bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/50 focus:outline-none focus:ring-1 focus:ring-inari-accent/30 transition-colors"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-mono text-zinc-500 uppercase tracking-wider">
                  Password
                </label>
                <Link
                  href="/forgot-password"
                  className="text-xs text-zinc-600 hover:text-inari-accent transition-colors"
                >
                  Forgot password?
                </Link>
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full rounded-lg border border-inari-border bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-700 focus:border-inari-accent/50 focus:outline-none focus:ring-1 focus:ring-inari-accent/30 transition-colors"
              />
            </div>

            {needs2FA && (
              <div>
                <label className="block text-xs font-mono text-zinc-500 uppercase tracking-wider mb-1.5">
                  2FA Code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={totp}
                  onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))}
                  placeholder="000000"
                  autoFocus
                  className="w-full rounded-lg border border-inari-border bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 text-center font-mono tracking-widest placeholder-zinc-700 focus:border-inari-accent/50 focus:outline-none focus:ring-1 focus:ring-inari-accent/30 transition-colors"
                />
              </div>
            )}

            {error && (
              <p className="text-sm text-red-400 font-mono">{error}</p>
            )}

            <Button
              variant="primary"
              className="w-full mt-2"
              type="submit"
              disabled={loading}
            >
              {loading ? "Signing in…" : needs2FA ? "Verify & Sign in" : "Sign in"}
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-zinc-600">
          Don&apos;t have an account?{" "}
          <Link href="/register" className="text-zinc-400 hover:text-white transition-colors">
            Create one free →
          </Link>
        </p>
      </div>
    </div>
  );
}
