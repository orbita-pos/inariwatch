import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Download InariWatch Bot",
  description: "Get InariWatch Bot on your phone — push alerts, AI diagnosis, fix from anywhere.",
};

export default function DownloadPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-6">
      <div className="max-w-md w-full space-y-8 text-center">
        {/* Logo */}
        <div>
          <Image src="/logo-inari/favicon-96x96.png" alt="InariWatch" width={80} height={80} className="mb-4 mx-auto" />
          <h1 className="text-3xl font-bold text-white">InariWatch Bot</h1>
          <p className="mt-2 text-zinc-400 text-lg">
            Production alerts. AI diagnosis. Fix from your phone.
          </p>
        </div>

        {/* Features */}
        <div className="grid grid-cols-2 gap-3 text-left">
          {[
            { emoji: "🔔", text: "Push alerts 24/7" },
            { emoji: "🔧", text: "Fix in one tap" },
            { emoji: "🧠", text: "Ask Inari AI" },
            { emoji: "📊", text: "Uptime & status" },
          ].map((f) => (
            <div key={f.text} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2">
              <span>{f.emoji}</span>
              <span className="text-sm text-zinc-300">{f.text}</span>
            </div>
          ))}
        </div>

        {/* Coming soon */}
        <div className="space-y-4">
          <div className="rounded-xl border border-[#7c3aed]/30 bg-[#7c3aed]/10 px-6 py-8">
            <p className="text-2xl font-bold text-white mb-2">Coming Soon</p>
            <p className="text-zinc-400">
              InariWatch Bot for Android &amp; iOS is in development.
              Push alerts, AI diagnosis, and one-tap fixes — right from your phone.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-center opacity-50">
              <p className="text-sm font-semibold text-zinc-400">Android APK</p>
              <p className="text-xs text-zinc-600 mt-1">Coming soon</p>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-center opacity-50">
              <p className="text-sm font-semibold text-zinc-400">iOS TestFlight</p>
              <p className="text-xs text-zinc-600 mt-1">Coming soon</p>
            </div>
          </div>
        </div>

        {/* Version */}
        <div className="pt-4 border-t border-zinc-800">
          <p className="text-xs text-zinc-600">InariWatch Bot v1.0.0</p>
          <Link href="/" className="text-xs text-[#7c3aed] hover:underline">
            Back to InariWatch
          </Link>
        </div>
      </div>
    </div>
  );
}
