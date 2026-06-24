/**
 * S12 — mobile PWA entry. Routes the user to /mobile/pair when no
 * device token is present, /mobile/inbox otherwise.
 *
 * Uses a client component for the localStorage probe — the device
 * token is stored client-side because (a) PWAs run inside the user's
 * browser keychain and (b) the JWT is workspace-scoped, not user-
 * scoped, so its loss is recoverable via re-pairing.
 */

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function MobileIndex() {
  const router = useRouter();
  useEffect(() => {
    const token = typeof window !== "undefined"
      ? window.localStorage.getItem("inari.mobile.deviceToken")
      : null;
    router.replace(token ? "/mobile/inbox" : "/mobile/pair");
  }, [router]);
  return (
    <main className="flex min-h-screen items-center justify-center text-sm opacity-70">
      Loading…
    </main>
  );
}
