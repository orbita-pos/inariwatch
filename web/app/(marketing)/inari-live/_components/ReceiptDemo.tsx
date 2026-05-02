"use client";

/**
 * Sesión 30 — Sections 2 + 3:
 *   Section 2: "Every AI fix has a cryptographic receipt"
 *   Section 3: "Replay against the bug — proof, not prediction"
 *
 * Section 2 renders an interactive fake diff card. Hover (or focus)
 * surfaces the EAP receipt chip + Replay button, mirroring the S27
 * dock UI. Clicking the chip opens the public verifier at
 * verify.inariwatch.com/r/<base64> — the URL is built with the same
 * `encodeShareable` helper from S29 (`web/lib/eap-verify.ts`). The
 * fixture used here is a Merkle-only receipt: it always validates as
 * "tamper-evident, no attestor identity" PASS, so visitors see a
 * realistic verifier flow without a real attestor key being shipped
 * in marketing source.
 *
 * Section 3 is an animated SVG that cycles a red bug → green tick to
 * reinforce "Replay isn't a prediction; it's the same I/O the bug
 * happened on, played back against the fix."
 */

import { useMemo, useState } from "react";
import { encodeShareable } from "@/lib/eap-verify";

const FIXTURE_RECEIPT_JSON = JSON.stringify({
  version: "eap-1",
  receipt_id:
    "9af1d4c0a3b87216c5e9d2087f3a1b8c4d6e9072f8a51c3b6d4e7f01a2c5d6e8",
  merkle_root:
    "9af1d4c0a3b87216c5e9d2087f3a1b8c4d6e9072f8a51c3b6d4e7f01a2c5d6e8",
  signed: false,
  attestor: "inariwatch",
  model: "qwen2.5-coder-1.5b-q4_k_m",
  timestamp: "2026-05-01T00:00:00Z",
  tools: ["read_file", "search_code", "patch"],
  files_read: ["src/auth/login.ts", "src/lib/session.ts"],
  recording_id: "rec_2026-05-01_demo",
});

const SHORT_KEY_ID = "66687aadf862bd77";

const FAKE_DIFF = [
  { kind: "context" as const, text: "export async function login(req: Request) {" },
  { kind: "context" as const, text: "  const body = await req.json();" },
  { kind: "remove" as const, text: "  if (body.email && body.password) {" },
  { kind: "add" as const, text: "  if (body?.email?.trim() && body?.password) {" },
  { kind: "context" as const, text: "    return signSession(body.email);" },
  { kind: "context" as const, text: "  }" },
];

export function ReceiptDemo() {
  const [hovered, setHovered] = useState(false);

  const verifyUrl = useMemo(() => {
    const segment = encodeShareable(FIXTURE_RECEIPT_JSON);
    if (!segment) return "/verify";
    return `/verify/r/${segment}`;
  }, []);

  return (
    <>
      <section className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div className="order-2 lg:order-1">
            <div
              data-testid="receipt-demo"
              data-hovered={hovered ? "true" : "false"}
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
              onFocus={() => setHovered(true)}
              onBlur={() => setHovered(false)}
              tabIndex={0}
              className="group relative overflow-hidden rounded-xl border border-inari-border bg-[#0a0a0c] font-mono text-[13px] leading-relaxed shadow-2xl outline-none focus-visible:border-inari-accent/60"
            >
              <div className="flex items-center gap-1.5 border-b border-white/5 px-4 py-2 text-[11px] text-white/40">
                <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
                <span className="ml-3">login.ts · AI fix #4291</span>
              </div>
              <div className="space-y-1 p-4">
                {FAKE_DIFF.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.kind === "add"
                        ? "rounded bg-emerald-500/10 px-2 text-emerald-300"
                        : line.kind === "remove"
                          ? "rounded bg-red-500/10 px-2 text-red-300/80 line-through decoration-red-300/50"
                          : "px-2 text-white/70"
                    }
                  >
                    {line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : "  "}
                    {line.text}
                  </div>
                ))}
              </div>

              {/* Chip + Replay row — appears on hover/focus, mirroring S27 */}
              <div
                data-testid="receipt-chip-row"
                className={`flex flex-wrap items-center gap-2 border-t border-white/5 bg-black/40 px-4 py-3 text-[11px] transition-opacity duration-200 ${
                  hovered ? "opacity-100" : "opacity-0"
                }`}
              >
                <a
                  href={verifyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="receipt-chip"
                  className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 font-mono text-emerald-300 hover:border-emerald-400 hover:bg-emerald-500/20"
                  title="Open the public verifier"
                >
                  <span aria-hidden>●</span>
                  <span>EAP · Merkle-only</span>
                  <span className="text-emerald-300/60">{SHORT_KEY_ID}</span>
                </a>
                <button
                  type="button"
                  data-testid="receipt-replay"
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-white/5 px-2.5 py-1 font-mono text-white/70 hover:border-inari-accent/40 hover:text-white"
                >
                  <span aria-hidden>▶</span>
                  <span>Replay</span>
                </button>
                <span className="ml-auto text-white/40">
                  Hover renders this row in the dock too
                </span>
              </div>
            </div>
          </div>

          <div className="order-1 lg:order-2">
            <span className="inline-flex items-center rounded-full border border-inari-border bg-inari-card px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-fg-muted">
              02 · Cryptographic receipts
            </span>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-fg-strong sm:text-4xl">
              Every AI fix has a cryptographic receipt
            </h2>
            <p className="mt-4 text-base text-fg-base leading-relaxed">
              EAP-1: a Merkle commitment over the substrate event stream that
              produced the fix, plus an Ed25519 attestor signature. Click the
              chip to open the public verifier — runs in the browser with{" "}
              <code className="font-mono text-fg-strong">@noble/curves</code>,
              uploads nothing, returns a signed/Merkle-only/invalid verdict in
              under a millisecond.
            </p>
            <ul className="mt-6 space-y-2 text-sm text-fg-base">
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
                Standalone <code className="font-mono text-fg-strong">inari verify</code> CLI ships in the same binary — exit code 0/1/2, scriptable in CI.
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
                Receipt JSON is portable: drop it in a PR, attach it to a postmortem, share a verifier URL.
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
                Metadata fields (<code className="font-mono">prompt_hash</code>, <code className="font-mono">tools</code>, <code className="font-mono">files_read</code>) are display-only — auditors see the disclosure on every surface.
              </li>
            </ul>
            <a
              href="/verify"
              className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-inari-accent hover:text-inari-accent/80"
            >
              Open verify.inariwatch.com →
            </a>
          </div>
        </div>
      </section>

      {/* ── Section 3 — Replay animation ─────────────────────────────── */}
      <section
        data-testid="replay-section"
        className="mx-auto max-w-6xl px-6 py-20 sm:py-24"
      >
        <div className="grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-center">
          <div>
            <span className="inline-flex items-center rounded-full border border-inari-border bg-inari-card px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-fg-muted">
              03 · Replay
            </span>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-fg-strong sm:text-4xl">
              Replay against the bug — proof, not prediction
            </h2>
            <p className="mt-4 text-base text-fg-base leading-relaxed">
              The same I/O that triggered the bug — DB queries, HTTP calls,
              file reads — captured by Substrate and replayed against the
              fix. Either the fix passes, or it doesn&rsquo;t. No model
              opinions, no &ldquo;looks reasonable&rdquo;, no test theatre.
            </p>
            <p className="mt-3 text-sm text-fg-muted">
              Backed by Hetzner&rsquo;s <code className="font-mono">/v2/replay</code> endpoint
              and the Tauri dock&rsquo;s Replay button (S27). Bug fingerprint goes
              red → green or it doesn&rsquo;t merge.
            </p>
          </div>
          <ReplayCycleSvg />
        </div>
      </section>
    </>
  );
}

function ReplayCycleSvg() {
  return (
    <div className="flex items-center justify-center rounded-xl border border-inari-border bg-inari-card p-10">
      <svg
        viewBox="0 0 320 160"
        className="w-full max-w-md"
        role="img"
        aria-label="Animation: bug fingerprint cycles from red to green as the fix passes Replay"
      >
        <defs>
          <linearGradient id="arrowGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#ef4444" />
            <stop offset="100%" stopColor="#10b981" />
          </linearGradient>
        </defs>

        {/* Left card — RED bug */}
        <g>
          <rect
            x="10"
            y="30"
            width="100"
            height="100"
            rx="14"
            fill="rgba(239,68,68,0.08)"
            stroke="rgba(239,68,68,0.5)"
            strokeWidth="1.5"
          />
          <text
            x="60"
            y="62"
            textAnchor="middle"
            fontSize="10"
            fontFamily="ui-monospace, SFMono-Regular, monospace"
            fill="rgba(255,255,255,0.5)"
          >
            BEFORE
          </text>
          <circle cx="60" cy="92" r="14" fill="#ef4444" opacity="0.9" />
          <path
            d="M52 92 L58 98 L70 86"
            stroke="#0a0a0c"
            strokeWidth="2.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0"
          />
          <text
            x="60"
            y="124"
            textAnchor="middle"
            fontSize="9"
            fontFamily="ui-monospace, SFMono-Regular, monospace"
            fill="rgba(239,68,68,0.85)"
          >
            FAIL
          </text>
        </g>

        {/* Arrow */}
        <line
          x1="120"
          y1="80"
          x2="200"
          y2="80"
          stroke="url(#arrowGrad)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <polygon
          points="200,75 210,80 200,85"
          fill="#10b981"
        />
        <text
          x="160"
          y="70"
          textAnchor="middle"
          fontSize="9"
          fontFamily="ui-monospace, SFMono-Regular, monospace"
          fill="rgba(255,255,255,0.5)"
        >
          REPLAY
        </text>

        {/* Right card — GREEN tick */}
        <g>
          <rect
            x="220"
            y="30"
            width="100"
            height="100"
            rx="14"
            fill="rgba(16,185,129,0.08)"
            stroke="rgba(16,185,129,0.5)"
            strokeWidth="1.5"
          />
          <text
            x="270"
            y="62"
            textAnchor="middle"
            fontSize="10"
            fontFamily="ui-monospace, SFMono-Regular, monospace"
            fill="rgba(255,255,255,0.5)"
          >
            AFTER
          </text>
          <circle cx="270" cy="92" r="14" fill="#10b981">
            <animate
              attributeName="r"
              values="14;15;14"
              dur="2.4s"
              repeatCount="indefinite"
            />
          </circle>
          <path
            d="M262 92 L268 98 L280 86"
            stroke="#0a0a0c"
            strokeWidth="2.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <text
            x="270"
            y="124"
            textAnchor="middle"
            fontSize="9"
            fontFamily="ui-monospace, SFMono-Regular, monospace"
            fill="rgba(16,185,129,0.85)"
          >
            PASS
          </text>
        </g>
      </svg>
    </div>
  );
}
