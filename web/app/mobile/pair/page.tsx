/**
 * S12 — /mobile/pair
 *
 * Single-page pairing flow:
 *   1. User types or pastes the 8-char Crockford code (URL `?code=`
 *      prefills it).
 *   2. We POST `/api/mobile/pair/redeem` with `{code, device_pubkey,
 *      display_name}`. The server returns `{sas_challenge_id,
 *      sas_digits}`.
 *   3. We show the SAS digits. User compares with desktop, clicks Yes
 *      on desktop. We poll `/api/mobile/pair/status` every 2s.
 *   4. Once `paired: true`, we save the device JWT to localStorage and
 *      redirect to `/mobile/inbox`.
 *
 * The "device pubkey" is a client-only random buffer — we don't have
 * a real keypair on iOS Safari (Web Crypto's persistent keys are
 * subtle to share + this isn't a crypto channel, just an identifier).
 * Generating from `crypto.getRandomValues` is fine for the pairing
 * binding.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

interface RedeemResp {
  sas_challenge_id: string;
  sas_digits:       string;
}

interface StatusResp {
  paired:        boolean;
  rejected?:     boolean;
  expired?:      boolean;
  device_token?: string;
  device?:       { deviceId: string; workspaceId: string; displayName: string };
}

type Phase =
  | { kind: "input" }
  | { kind: "redeeming" }
  | { kind: "sas"; challengeId: string; sasDigits: string }
  | { kind: "rejected" }
  | { kind: "expired" }
  | { kind: "error"; message: string };

const PUBKEY_KEY        = "inari.mobile.devicePubkey";
const TOKEN_KEY         = "inari.mobile.deviceToken";
const DISPLAY_NAME_KEY  = "inari.mobile.displayName";

function getOrCreatePubkey(): string {
  if (typeof window === "undefined") return "";
  let pk = window.localStorage.getItem(PUBKEY_KEY);
  if (pk && pk.length >= 32) return pk;
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  pk = Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
  window.localStorage.setItem(PUBKEY_KEY, pk);
  return pk;
}

function defaultDisplayName(): string {
  if (typeof navigator === "undefined") return "Mobile";
  // Best-effort device label — UA parsing is fragile but acceptable
  // for a default the user can edit.
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Mobile";
}

export default function MobilePairPage() {
  const router = useRouter();
  const params = useSearchParams();
  const initialCode = useMemo(() => {
    const c = params.get("code") ?? "";
    return c.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  }, [params]);

  const [code, setCode]               = useState(initialCode);
  const [displayName, setDisplayName] = useState("");
  const [phase, setPhase]             = useState<Phase>({ kind: "input" });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(DISPLAY_NAME_KEY);
    setDisplayName(stored && stored.trim().length > 0 ? stored : defaultDisplayName());
  }, []);

  // Poll status while in `sas` phase.
  useEffect(() => {
    if (phase.kind !== "sas") return;
    let cancelled = false;
    const challengeId = phase.challengeId;
    const tick = async () => {
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, 2000));
        if (cancelled) break;
        try {
          const r = await fetch(`/api/mobile/pair/status?challenge_id=${encodeURIComponent(challengeId)}`);
          if (!r.ok) continue;
          const j = (await r.json()) as StatusResp;
          if (j.paired && j.device_token) {
            window.localStorage.setItem(TOKEN_KEY, j.device_token);
            window.localStorage.setItem(DISPLAY_NAME_KEY, displayName);
            router.replace("/mobile/inbox");
            return;
          }
          if (j.rejected) {
            setPhase({ kind: "rejected" });
            return;
          }
          if (j.expired) {
            setPhase({ kind: "expired" });
            return;
          }
        } catch {
          // network blip — keep polling
        }
      }
    };
    void tick();
    return () => { cancelled = true; };
  }, [phase, displayName, router]);

  const submit = async () => {
    const normCode = code.trim().toUpperCase();
    if (normCode.length !== 8) {
      setPhase({ kind: "error", message: "Pairing codes are 8 characters." });
      return;
    }
    setPhase({ kind: "redeeming" });
    const pubkey = getOrCreatePubkey();
    try {
      const r = await fetch("/api/mobile/pair/redeem", {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code:          normCode,
          device_pubkey: pubkey,
          display_name:  displayName.trim() || defaultDisplayName(),
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
        const msg = j.message ?? j.error ?? `Redeem failed (${r.status})`;
        setPhase({ kind: "error", message: msg });
        return;
      }
      const j = (await r.json()) as RedeemResp;
      setPhase({ kind: "sas", challengeId: j.sas_challenge_id, sasDigits: j.sas_digits });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "Network error" });
    }
  };

  const restart = () => setPhase({ kind: "input" });

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Pair this device</h1>
        <p className="text-sm opacity-70">
          Open Inari Live on your desktop, go to Settings → Channels → Mobile, and start a
          pairing flow. Type the 8-character code below.
        </p>
      </header>

      {phase.kind === "input" || phase.kind === "redeeming" || phase.kind === "error" ? (
        <section className="flex flex-col gap-4">
          <label className="flex flex-col gap-2 text-sm">
            Pairing code
            <input
              data-testid="pair-code-input"
              autoFocus
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={9}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 9))}
              placeholder="ABCD-EFGH"
              className="rounded-md border border-white/10 bg-white/5 px-4 py-3 font-mono text-lg tracking-[0.4em]"
            />
          </label>
          <label className="flex flex-col gap-2 text-sm">
            Device name
            <input
              data-testid="pair-display-name-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value.slice(0, 60))}
              className="rounded-md border border-white/10 bg-white/5 px-4 py-3 text-sm"
            />
          </label>
          <button
            data-testid="pair-submit"
            disabled={phase.kind === "redeeming"}
            onClick={() => void submit()}
            className="mt-2 rounded-md bg-[#f0c544] px-4 py-3 font-medium text-black disabled:opacity-60"
          >
            {phase.kind === "redeeming" ? "Pairing…" : "Pair"}
          </button>
          {phase.kind === "error" ? (
            <p data-testid="pair-error" className="text-sm text-red-400">
              {phase.message}
            </p>
          ) : null}
        </section>
      ) : null}

      {phase.kind === "sas" ? (
        <section data-testid="pair-sas-display" className="flex flex-col items-center gap-4">
          <p className="text-sm opacity-70">
            Compare these digits with the desktop. If they match, click <strong>Yes</strong> on
            the desktop. They expire in five minutes.
          </p>
          <div
            data-testid="pair-sas-digits"
            aria-label={`SAS digits ${phase.sasDigits}`}
            className="rounded-md border border-white/10 bg-white/5 px-6 py-4 font-mono text-3xl tracking-[0.4em]"
          >
            {phase.sasDigits.replace(/(\d{3})(\d{3})/, "$1 $2")}
          </div>
          <p className="text-xs opacity-50">Waiting for confirmation on desktop…</p>
        </section>
      ) : null}

      {phase.kind === "rejected" ? (
        <section className="flex flex-col gap-3">
          <p data-testid="pair-rejected" className="text-sm">
            The desktop rejected this pairing. Generate a fresh code and try again.
          </p>
          <button onClick={restart} className="rounded-md bg-white/10 px-4 py-3 text-sm">
            Restart
          </button>
        </section>
      ) : null}

      {phase.kind === "expired" ? (
        <section className="flex flex-col gap-3">
          <p data-testid="pair-expired" className="text-sm">
            The pairing code expired. Generate a fresh one on the desktop.
          </p>
          <button onClick={restart} className="rounded-md bg-white/10 px-4 py-3 text-sm">
            Restart
          </button>
        </section>
      ) : null}
    </main>
  );
}
