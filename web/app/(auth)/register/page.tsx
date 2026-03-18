"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { registerUser } from "./actions";

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
        <div className="rounded-2xl border border-white/20 bg-white/10 backdrop-blur-xl p-8 shadow-[0_0_80px_rgba(59,130,246,0.15)] transition-all duration-500 hover:shadow-[0_0_120px_rgba(59,130,246,0.25)]">
          
          {/* OAuth */}
          <div className="space-y-2">
            <Button
              variant="outline"
              className="w-full border-white/20 text-white hover:bg-white/10"
              onClick={() => signIn("github", { callbackUrl: "/dashboard" })}
            >
              <Github className="h-4 w-4" />
              Continue with GitHub
            </Button>

            <Button
              variant="outline"
              className="w-full border-white/20 text-white hover:bg-white/10"
              onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
            >
              Continue with Google
            </Button>
          </div>

          <div className="my-6 flex items-center gap-3">
            <div className="flex-1 h-px bg-white/10" />
            <span className="text-xs text-zinc-500 font-mono">or</span>
            <div className="flex-1 h-px bg-white/10" />
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-inari-accent/50 focus:outline-none focus:ring-1 focus:ring-inari-accent/30"
            />

            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-inari-accent/50 focus:outline-none focus:ring-1 focus:ring-inari-accent/30"
            />

            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
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
              {loading ? "Creating account…" : "Create account"}
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-zinc-500">
          Already have an account?{" "}
          <Link href="/login" className="text-zinc-300 hover:text-white">
            Sign in →
          </Link>
        </p>
      </div>
    </div>
  );
}