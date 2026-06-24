/**
 * PlayerPanel — full-screen incident movie browser.
 *
 * Opened via Ctrl+Shift+I from anywhere in Inari Live. Shows the 20
 * most recent alerts; clicking one expands the PlayerCard inline.
 * No AI involved — pure data fetch from the cloud.
 */

import { useEffect, useState } from "react";
import { X, Film, AlertTriangle, Clock } from "lucide-react";
import { cn } from "@/lib/cn";
import { cloudGetAlerts, type CloudAlert } from "@/lib/cloud-ipc";
import { PlayerCard } from "@/components/PlayerCard";
import { InariMark } from "@/screens/MainWindow";

interface PlayerPanelProps {
  onClose: () => void;
}

function severityColor(s: string) {
  if (s === "critical") return { dot: "#D08585", badge: "rgba(208,133,133,0.15)" };
  if (s === "warning")  return { dot: "#D4B47A", badge: "rgba(212,180,122,0.15)" };
  return { dot: "#7B9EDB", badge: "rgba(123,158,219,0.12)" };
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function PlayerPanel({ onClose }: PlayerPanelProps) {
  const [alerts, setAlerts]       = useState<CloudAlert[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [selected, setSelected]   = useState<CloudAlert | null>(null);

  useEffect(() => {
    cloudGetAlerts(20)
      .then((rows) => {
        setAlerts(rows);
        setLoading(false);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg.includes("not_connected") ? "Not connected to InariWatch" : "Could not load alerts");
        setLoading(false);
      });
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "var(--bg)" }}
      data-testid="player-panel"
    >
      {/* Header */}
      <header
        className="flex items-center gap-3 px-5 shrink-0"
        style={{
          height: 52,
          borderBottom: "1px solid var(--border)",
          background: "linear-gradient(180deg, rgba(255,255,255,0.025), rgba(255,255,255,0) 70%)",
        }}
      >
        <InariMark size={14} />
        <Film size={14} style={{ color: "var(--text-subtle)" }} />
        <span className="text-[13px] font-medium" style={{ color: "var(--text)" }}>
          Incident Player
        </span>
        <kbd
          className="ml-1 text-[10px] px-1.5 py-0.5 rounded-[4px]"
          style={{
            fontFamily: "var(--font-mono)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            color: "var(--text-faint)",
          }}
        >
          Ctrl+Shift+I
        </kbd>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors hover:bg-white/[0.05]"
          style={{ color: "var(--text-subtle)" }}
          aria-label="Close"
        >
          <X size={15} />
        </button>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Left — alert list */}
        <div
          className="w-[280px] shrink-0 flex flex-col overflow-y-auto"
          style={{ borderRight: "1px solid var(--border)" }}
        >
          <p
            className="px-4 pt-4 pb-2 text-[10.5px] font-semibold uppercase tracking-widest"
            style={{ color: "var(--text-faint)" }}
          >
            Recent alerts
          </p>

          {loading && (
            <div className="flex-1 flex items-center justify-center">
              <span className="text-[12px]" style={{ color: "var(--text-subtle)" }}>
                Loading…
              </span>
            </div>
          )}

          {error && (
            <div className="px-4 py-3 flex items-center gap-2 text-[12px]" style={{ color: "var(--text-subtle)" }}>
              <AlertTriangle size={13} style={{ color: "#D08585" }} />
              {error}
            </div>
          )}

          {!loading && !error && alerts.length === 0 && (
            <div className="px-4 py-3 text-[12px]" style={{ color: "var(--text-subtle)" }}>
              No alerts found.
            </div>
          )}

          {alerts.map((a) => {
            const { dot } = severityColor(a.severity);
            const isSelected = selected?.id === a.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setSelected(isSelected ? null : a)}
                className={cn(
                  "w-full text-left px-4 py-3 flex flex-col gap-1 transition-colors",
                  "border-b",
                  isSelected
                    ? "bg-white/[0.04]"
                    : "hover:bg-white/[0.025]",
                )}
                style={{ borderColor: "var(--border)" }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: dot }}
                  />
                  <span
                    className="text-[11.5px] font-medium leading-[1.3] line-clamp-2 flex-1"
                    style={{ color: isSelected ? "var(--text)" : "var(--text-muted)" }}
                  >
                    {a.title}
                  </span>
                </div>
                <div className="flex items-center gap-2 pl-3.5">
                  <span className="text-[10.5px]" style={{ color: "var(--text-faint)" }}>
                    {a.projectName}
                  </span>
                  <span style={{ color: "var(--text-faint)" }}>·</span>
                  <span className="text-[10.5px] flex items-center gap-1" style={{ color: "var(--text-faint)" }}>
                    <Clock size={9} />
                    {relativeTime(a.createdAt)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Right — player */}
        <div className="flex-1 flex flex-col overflow-y-auto p-6">
          {!selected ? (
            <div
              className="flex-1 flex flex-col items-center justify-center gap-3 text-center"
              style={{ color: "var(--text-subtle)" }}
            >
              <Film size={32} strokeWidth={1.2} style={{ color: "var(--text-faint)" }} />
              <p className="text-[13px]">Select an alert to watch the incident movie</p>
              <p className="text-[11.5px]" style={{ color: "var(--text-faint)" }}>
                Session replay · AI diagnosis · Fix · Before/after preview
              </p>
            </div>
          ) : (
            <div className="max-w-[520px] w-full mx-auto">
              <PlayerCardByAlertId alertId={selected.id} title={selected.title} severity={selected.severity} inariHash={selected.inariHash} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Resolves the inariHash for an alertId via the existing /api/r resolver,
 * then renders a PlayerCard. The cloud alerts list DTO doesn't carry
 * inariHash yet — this bridges the gap without changing the DTO.
 */
function PlayerCardByAlertId({
  alertId,
  title,
  severity,
  inariHash,
}: {
  alertId: string;
  title: string;
  severity: string;
  inariHash: string | null;
}) {
  const [hash, setHash] = useState<string | null>(inariHash);
  const [err, setErr]   = useState<string | null>(null);

  useEffect(() => {
    if (inariHash) {
      setHash(inariHash);
      setErr(null);
      return;
    }
    // Alert predates inariHash backfill — prompt the user to open from chat.
    setErr("Open this alert in chat to watch — say:\n\"Show me the movie of " + title.slice(0, 40) + "\"");
  }, [alertId, inariHash, title]);

  if (err) {
    const { dot } = severityColor(severity);
    return (
      <div
        className="rounded-[12px] p-5 flex flex-col gap-3"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-2.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />
          <span className="text-[13px] font-medium leading-[1.4]" style={{ color: "var(--text)" }}>
            {title}
          </span>
        </div>
        <p className="text-[12px] leading-[1.6] whitespace-pre-line" style={{ color: "var(--text-subtle)" }}>
          {err}
        </p>
      </div>
    );
  }

  if (!hash) return null;
  return <PlayerCard hash={hash} />;
}
