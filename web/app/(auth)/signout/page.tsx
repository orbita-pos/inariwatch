"use client";

import { signOut } from "next-auth/react";
import Link from "next/link";
import Image from "next/image";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function SignOutPage() {
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

      {/* Card container */}
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
        </div>

        {/* Glass Card */}
        <div className="rounded-2xl border border-white/20 bg-white/10 backdrop-blur-xl p-8 text-center shadow-[0_0_80px_rgba(59,130,246,0.15)] transition-all duration-500 hover:shadow-[0_0_120px_rgba(59,130,246,0.25)]">
          
          {/* Icon */}
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-white/10">
            <LogOut className="h-5 w-5 text-white/70" />
          </div>

          {/* Title */}
          <h1 className="text-xl font-semibold tracking-tight text-white">
            Leaving already?
          </h1>

          {/* Subtext */}
          <p className="mt-2 text-sm text-zinc-400">
            Inari will keep watching. You can come back anytime.
          </p>

          {/* Actions */}
          <div className="mt-8 flex flex-col gap-3">
            <Button
              variant="primary"
              className="w-full"
              onClick={() => signOut({ callbackUrl: "/login" })}
            >
              Yes, sign out
            </Button>

            <Link href="/dashboard">
              <Button variant="outline" className="w-full border-white/20 text-white hover:bg-white/10">
                Cancel
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}