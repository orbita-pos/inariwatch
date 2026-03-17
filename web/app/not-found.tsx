import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title:       "Page Not Found",
  description: "The page you were looking for doesn't exist.",
  robots:      { index: false, follow: false },
};

export default function NotFound() {
  return (
    <div className="relative min-h-screen bg-inari-bg">
      {/* Full-bleed background */}
      <div className="absolute inset-0">
        <Image
          src="/not-found-bg.png"
          alt=""
          fill
          className="hidden object-cover object-center sm:block"
          priority
          quality={100}
        />
        <Image
          src="/not-found-bg-mobile.png"
          alt=""
          fill
          className="block object-cover object-top sm:hidden"
          priority
          quality={90}
        />
        <div className="absolute inset-0 bg-radial-fade" />
      </div>

      {/* Content — top-left on desktop, centered on mobile */}
      <div className="relative flex min-h-screen flex-col items-center justify-center px-6 sm:items-start sm:justify-start sm:px-16 sm:pt-16 lg:px-24 lg:pt-20">

        {/* Logo */}
        <Link href="/" className="inline-flex items-center gap-2.5">
          <Image
            src="/logo-inari/favicon-96x96.png"
            alt="InariWatch"
            width={32}
            height={32}
            className="shrink-0"
          />
          <span className="font-mono text-sm font-bold uppercase tracking-[0.15em] text-white">
            InariWatch
          </span>
        </Link>

        {/* Error block */}
        <div className="mt-10 w-full max-w-xs">
          <p className="font-mono text-6xl font-bold text-inari-accent leading-none">404</p>
          <h1 className="mt-3 text-2xl font-semibold text-white">Page not found</h1>
          <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
            Looks like this page got lost in the fog.
          </p>

          <div className="mt-8 flex flex-col gap-3">
            <Link href="/dashboard">
              <Button variant="primary" className="w-full">
                Back to dashboard
              </Button>
            </Link>
            <Link href="/">
              <Button variant="outline" className="w-full">
                Go home
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
