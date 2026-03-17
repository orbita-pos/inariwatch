"use client";

import { signOut } from "next-auth/react";
import Link from "next/link";
import Image from "next/image";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function SignOutPage() {
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

      {/* Card floating on top */}
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
        </div>

        <div className="rounded-2xl border border-inari-border bg-inari-card/90 backdrop-blur-sm p-8 shadow-[0_0_50px_rgba(0,0,0,0.5)] text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.06]">
            <LogOut className="h-5 w-5 text-zinc-400" />
          </div>

          <h1 className="text-lg font-semibold text-white">Sign out</h1>
          <p className="mt-2 text-sm text-zinc-500">
            Are you sure you want to sign out of InariWatch?
          </p>

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
