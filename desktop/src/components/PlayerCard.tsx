/**
 * PlayerCard — inline incident movie card rendered inside chat when Inari
 * responds with a ```player block containing an inariHash.
 *
 * Shows all available phases (session / error / fix / preview) as tabs.
 * Fetches the manifest once on mount via the cloud IPC bridge.
 *
 * "Watch movie" opens the full session in the web dashboard. The embedded
 * rrweb player is a future phase (S2 of the player feature).
 */

import { useEffect, useState } from "react";
import { KeyRound, Play, Film, AlertTriangle, Wrench, Eye, Loader2, ExternalLink, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { cloudGetMovieManifest, type MovieManifest } from "@/lib/cloud-ipc";

// ── helpers ──────────────────────────────────────────────────────────

function severityColor(s: string) {
  if (s === "critical") return { bg: "rgba(185,64,64,0.12)", border: "rgba(185,64,64,0.28)", text: "#D08585" };
  if (s === "warning")  return { bg: "rgba(185,145,64,0.12)", border: "rgba(185,145,64,0.28)", text: "#D4B47A" };
  return { bg: "rgba(100,140,210,0.10)", border: "rgba(100,140,210,0.25)", text: "#7B9EDB" };
}

function ratingColor(r: string) {
  if (r === "poor") return "#D08585";
  if (r === "needs-improvement") return "#D4B47A";
  return "#7FB088";
}

function fmtMs(ms: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function openInBrowser(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

// ── phase tab icons ───────────────────────────────────────────────────

const PHASE_META = {
  session: { label: "Session",  Icon: Film,          color: "#7B9EDB" },
  error:   { label: "Error",    Icon: AlertTriangle,  color: "#D08585" },
  fix:     { label: "Fix",      Icon: Wrench,         color: "#D4B47A" },
  preview: { label: "Preview",  Icon: Eye,            color: "#7FB088" },
} as const;

type PhaseKey = keyof typeof PHASE_META;

// ── sub-panels ────────────────────────────────────────────────────────

function SessionPanel({ phase }: { phase: NonNullable<MovieManifest["phases"]["session"]> }) {
  const vitals = Object.entries(phase.webVitals ?? {});
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {phase.browser && (
          <Chip>{phase.browser}</Chip>
        )}
        {phase.os && <Chip>{phase.os}</Chip>}
        {phase.durationMs != null && (
          <Chip>{fmtMs(phase.durationMs)} session</Chip>
        )}
        {phase.rageClicks.length > 0 && (
          <Chip color="rgba(185,64,64,0.18)" textColor="#D08585">
            {phase.rageClicks.length} rage click{phase.rageClicks.length !== 1 ? "s" : ""}
          </Chip>
        )}
        {phase.frustrationScore != null && phase.frustrationScore > 0 && (
          <Chip color="rgba(185,145,64,0.18)" textColor="#D4B47A">
            frustration {phase.frustrationScore}
          </Chip>
        )}
      </div>

      {vitals.length > 0 && (
        <div>
          <p className="text-[10.5px] mb-1.5" style={{ color: "var(--text-faint)" }}>
            Web Vitals
          </p>
          <div className="flex flex-wrap gap-2">
            {vitals.slice(0, 5).map(([key, v]) => (
              <div
                key={key}
                className="flex items-center gap-1.5 px-2 py-1 rounded-[6px] text-[11px]"
                style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
              >
                <span style={{ color: "var(--text-subtle)", fontFamily: "var(--font-mono)" }}>
                  {key.toUpperCase()}
                </span>
                <span style={{ color: ratingColor(v.rating), fontFamily: "var(--font-mono)" }}>
                  {fmtMs(v.value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {phase.aiSummary && (
        <p className="text-[12.5px] leading-[1.5] line-clamp-3" style={{ color: "var(--text-muted)" }}>
          {phase.aiSummary}
        </p>
      )}
    </div>
  );
}

function ErrorPanel({ phase }: { phase: MovieManifest["phases"]["error"] }) {
  return (
    <div className="space-y-2.5">
      {phase.diagnosis ? (
        <p className="text-[12.5px] leading-[1.55] line-clamp-4" style={{ color: "var(--text-muted)" }}>
          {phase.diagnosis}
        </p>
      ) : (
        <p className="text-[12.5px]" style={{ color: "var(--text-subtle)" }}>
          No AI diagnosis available yet.
        </p>
      )}
      {phase.fingerprint && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10.5px]" style={{ color: "var(--text-faint)" }}>fingerprint</span>
          <code
            className="text-[10.5px] px-1.5 py-0.5 rounded-[4px]"
            style={{
              fontFamily: "var(--font-mono)",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--text-subtle)",
            }}
          >
            {phase.fingerprint.slice(0, 20)}…
          </code>
        </div>
      )}
    </div>
  );
}

function FixPanel({ phase }: { phase: NonNullable<MovieManifest["phases"]["fix"]> }) {
  const fileCount = Array.isArray(phase.fileChanges) ? phase.fileChanges.length : null;
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-2">
        <Chip color="rgba(127,176,136,0.18)" textColor="#7FB088">
          {phase.status}
        </Chip>
        {phase.confidenceScore != null && (
          <Chip color="rgba(127,176,136,0.18)" textColor="#7FB088">
            {phase.confidenceScore}% confidence
          </Chip>
        )}
        {fileCount != null && (
          <Chip>{fileCount} file{fileCount !== 1 ? "s" : ""} changed</Chip>
        )}
      </div>
      {phase.prUrl && (
        <button
          type="button"
          onClick={() => openInBrowser(phase.prUrl!)}
          className="flex items-center gap-1.5 text-[12px] hover:opacity-80 transition-opacity"
          style={{ color: "var(--accent)" }}
        >
          <ExternalLink size={11} />
          View pull request
        </button>
      )}
    </div>
  );
}

function PreviewPanel({ phase }: { phase: NonNullable<MovieManifest["phases"]["preview"]> }) {
  return (
    <div className="space-y-2.5">
      {phase.diffSummary && (
        <p className="text-[12.5px] leading-[1.55] line-clamp-3" style={{ color: "var(--text-muted)" }}>
          {phase.diffSummary}
        </p>
      )}
      {phase.confidence != null && (
        <div className="flex items-center gap-2">
          <div
            className="h-1.5 rounded-full overflow-hidden flex-1"
            style={{ background: "var(--surface-2)", maxWidth: 120 }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${phase.confidence}%`,
                background: phase.confidence >= 70 ? "#7FB088" : phase.confidence >= 40 ? "#D4B47A" : "#D08585",
              }}
            />
          </div>
          <span className="text-[11px]" style={{ color: "var(--text-subtle)" }}>
            {phase.confidence}% prediction confidence
          </span>
        </div>
      )}
      {phase.screenshotUrl && (
        <div
          className="rounded-[8px] overflow-hidden"
          style={{ border: "1px solid var(--border)", maxHeight: 120 }}
        >
          <img
            src={phase.screenshotUrl}
            alt="Fix preview screenshot"
            className="w-full object-cover object-top"
            style={{ maxHeight: 120 }}
          />
        </div>
      )}
    </div>
  );
}

// ── small chip helper ─────────────────────────────────────────────────

function Chip({
  children,
  color,
  textColor,
}: {
  children: React.ReactNode;
  color?: string;
  textColor?: string;
}) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px]"
      style={{
        background: color ?? "var(--surface)",
        border: "1px solid var(--border)",
        color: textColor ?? "var(--text-subtle)",
      }}
    >
      {children}
    </span>
  );
}

// ── main component ────────────────────────────────────────────────────

interface PlayerCardProps {
  hash: string;
}

export function PlayerCard({ hash }: PlayerCardProps) {
  const [manifest, setManifest] = useState<MovieManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activePhase, setActivePhase] = useState<PhaseKey>("error");

  useEffect(() => {
    let cancelled = false;
    cloudGetMovieManifest(hash)
      .then((m) => {
        if (cancelled) return;
        setManifest(m);
        // Default to first available phase
        const first = (m.available[0] ?? "error") as PhaseKey;
        setActivePhase(first);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg.includes("not_connected") ? "Not connected to InariWatch" : "Could not load incident");
      });
    return () => { cancelled = true; };
  }, [hash]);

  // ── loading state ─────────────────────────────────────────────────
  if (!manifest && !error) {
    return (
      <div
        className="flex items-center gap-2.5 px-4 py-3 rounded-[12px] text-[12.5px]"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-subtle)" }}
      >
        <Loader2 size={13} className="animate-spin shrink-0" style={{ color: "var(--accent)" }} />
        Loading incident…
      </div>
    );
  }

  // ── error state ───────────────────────────────────────────────────
  if (error || !manifest) {
    return (
      <div
        className="flex items-center gap-2.5 px-4 py-3 rounded-[12px] text-[12.5px]"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-subtle)" }}
      >
        <AlertTriangle size={13} className="shrink-0" style={{ color: "#D08585" }} />
        {error ?? "Unknown error"}
      </div>
    );
  }

  const sev = severityColor(manifest.phases.error.severity);
  const available = manifest.available as PhaseKey[];
  const appUrl = "https://app.inariwatch.com";
  const alertUrl = `${appUrl}/alerts/${manifest.alertId}`;
  const shortHash = manifest.inariHash.split(":")[2]?.slice(0, 8) ?? manifest.inariHash.slice(-8);

  return (
    <div
      className="rounded-[12px] overflow-hidden text-[13px]"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      {/* Header */}
      <div
        className="flex items-start gap-2.5 px-4 pt-3.5 pb-3"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <span
          className="mt-[1px] shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide"
          style={{ background: sev.bg, border: `1px solid ${sev.border}`, color: sev.text }}
        >
          {manifest.phases.error.severity}
        </span>
        <p
          className="flex-1 leading-[1.4] font-medium line-clamp-2"
          style={{ color: "var(--text)" }}
        >
          {manifest.phases.error.title}
        </p>
        <span
          className="shrink-0 text-[10.5px] px-1.5 py-0.5 rounded-[4px]"
          style={{
            fontFamily: "var(--font-mono)",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            color: "var(--text-faint)",
          }}
        >
          {shortHash}
        </span>
      </div>

      {/* Phase tabs */}
      {available.length > 1 && (
        <div
          className="flex"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          {available.map((phase) => {
            const { label, Icon, color } = PHASE_META[phase];
            const isActive = activePhase === phase;
            return (
              <button
                key={phase}
                type="button"
                onClick={() => setActivePhase(phase)}
                className={cn(
                  "flex items-center gap-1.5 px-3.5 py-2 text-[11.5px] transition-colors flex-1 justify-center",
                  "border-b-2",
                )}
                style={{
                  borderBottomColor: isActive ? color : "transparent",
                  color: isActive ? color : "var(--text-subtle)",
                  background: isActive ? `${color}0a` : "transparent",
                }}
              >
                <Icon size={11} strokeWidth={isActive ? 2.2 : 1.8} />
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Phase content */}
      <div className="px-4 py-3.5">
        {activePhase === "session" && manifest.phases.session && (
          <SessionPanel phase={manifest.phases.session} />
        )}
        {activePhase === "error" && (
          <ErrorPanel phase={manifest.phases.error} />
        )}
        {activePhase === "fix" && manifest.phases.fix && (
          <FixPanel phase={manifest.phases.fix} />
        )}
        {activePhase === "preview" && manifest.phases.preview && (
          <PreviewPanel phase={manifest.phases.preview} />
        )}
      </div>

      {/* Footer */}
      <div
        className="flex items-center gap-2.5 px-4 py-2.5"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <button
          type="button"
          onClick={() => openInBrowser(alertUrl)}
          className={cn(
            "flex items-center gap-1.5 h-8 px-3 rounded-[8px] text-[12px] font-medium",
            "transition-transform active:scale-[0.97]",
          )}
          style={{
            background: "var(--accent)",
            color: "var(--accent-ink)",
            border: "1px solid rgba(0,0,0,0.18)",
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(0,0,0,0.08)",
          }}
        >
          <Play size={11} strokeWidth={2.5} />
          Watch movie
        </button>

        <span className="flex-1" />

        {/* Witness chip */}
        <span
          className="inline-flex items-center gap-1.5"
          style={{
            height: 22,
            padding: "0 8px 0 7px",
            borderRadius: 999,
            background: manifest.witness.eapReceiptId
              ? "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))"
              : "transparent",
            border: `1px solid ${manifest.witness.eapReceiptId ? "rgba(166,194,176,0.18)" : "var(--border)"}`,
            color: manifest.witness.eapReceiptId ? "var(--verified)" : "var(--text-subtle)",
            fontSize: 11,
            opacity: manifest.witness.eapReceiptId ? 1 : 0.55,
          }}
        >
          {manifest.witness.eapReceiptId
            ? <ShieldCheck size={11} strokeWidth={1.6} />
            : <KeyRound size={11} strokeWidth={1.6} />}
          <span>
            {manifest.witness.eapReceiptId ? "verified" : "no receipt"}
          </span>
          {manifest.witness.eapReceiptId && (
            <>
              <span style={{ color: "rgba(166,194,176,0.35)" }}>·</span>
              <span style={{ fontFamily: "var(--font-mono)", color: "#C8DDD0", letterSpacing: "0.01em" }}>
                {shortHash}
              </span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}
