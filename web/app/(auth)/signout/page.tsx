"use client";

import { signOut } from "next-auth/react";
import Link from "next/link";
import Image from "next/image";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import bgDesktopSrc from "@/public/login-new-3.png";
import bgMobileSrc from "@/public/login-side-mobile.png";

export default function SignOutPage() {
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
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-[0_8px_40px_rgba(0,0,0,0.35)]">
          
          {/* Icon */}
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100">
            <LogOut className="h-5 w-5 text-zinc-500" />
          </div>

          {/* Title */}
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
            Leaving already?
          </h1>

          {/* Subtext */}
          <p className="mt-2 text-sm text-zinc-500">
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
              <Button variant="outline" className="w-full">
                Cancel
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}