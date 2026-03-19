"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { registerUser } from "./actions";
import bgDesktopSrc from "@/public/login-new-3.png";
import bgMobileSrc from "@/public/login-side-mobile.png";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName]         = useState("");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const formData = new FormData();
    formData.set("name", name);
    formData.set("email", email);
    formData.set("password", password);

    const result = await registerUser(formData);

    if (!result.success) {
      setError(result.error ?? "Something went wrong.");
      setLoading(false);
      return;
    }

    const signInResult = await signIn("credentials", {
      email,
      password,
      callbackUrl: "/dashboard",
      redirect: false,
    });

    if (signInResult?.url) {
      router.push(signInResult.url);
    } else {
      router.push("/dashboard");
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

      {/* Form */}
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
            Create your account
          </h1>

          <p className="mt-1.5 text-sm text-zinc-400">
            Your AI is ready to watch your code
          </p>
        </div>

        {/* Glass Card */}
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-[0_8px_40px_rgba(0,0,0,0.35)]">
          
          {/* OAuth */}
          <div className="space-y-2">
            <Button
              variant="outline"
              className="w-full !text-zinc-800 !border-zinc-300 hover:!bg-zinc-50"
              onClick={() => signIn("github", { callbackUrl: "/dashboard" })}
            >
              <Github className="h-4 w-4" />
              Continue with GitHub
            </Button>

            <Button
              variant="outline"
              className="w-full !text-zinc-800 !border-zinc-300 hover:!bg-zinc-50"
              onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
            >
              Continue with Google
            </Button>

            <Button
              variant="outline"
              className="w-full !text-zinc-800 !border-zinc-300 hover:!bg-zinc-50"
              onClick={() => signIn("gitlab", { callbackUrl: "/dashboard" })}
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51a.42.42 0 01.82 0l2.44 7.51h8.06l2.44-7.51a.42.42 0 01.82 0l2.44 7.51 1.22 3.78a.84.84 0 01-.3.94z"/>
              </svg>
              Continue with GitLab
            </Button>
          </div>

          <div className="my-6 flex items-center gap-3">
            <div className="flex-1 h-px bg-zinc-200" />
            <span className="text-xs text-zinc-400 font-mono">or</span>
            <div className="flex-1 h-px bg-zinc-200" />
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-inari-accent/60 focus:outline-none focus:ring-2 focus:ring-inari-accent/20"
            />

            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-inari-accent/60 focus:outline-none focus:ring-2 focus:ring-inari-accent/20"
            />

            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
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
              {loading ? "Creating account…" : "Create account"}
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-white/70">
          Already have an account?{" "}
          <Link href="/login" className="text-white hover:text-white/80 font-medium">
            Sign in →
          </Link>
        </p>
      </div>
    </div>
  );
}