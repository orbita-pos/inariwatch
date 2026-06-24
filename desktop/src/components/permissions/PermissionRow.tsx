import { ChevronDown, KeyRound, RotateCcw } from "lucide-react";
import { useState } from "react";

import {
  effectivePermission,
  type PermissionLevel,
  type PermissionRow as PermissionRowType,
} from "@/lib/audit-ui-ipc";

/**
 * One row in the per-tool permission settings panel.
 *
 * 2026-05-07 design pivot: the row is now a 2-row grid — tool name +
 * witness chip on top, description + permission cycler on bottom,
 * plus a tertiary line with the default-permission caveat. The
 * cycler is a small bordered button with a colored dot + label +
 * chevron (Auto cream / Confirm gold / Deny red); clicking the row
 * cycles through the three levels.
 *
 * Witness chip is rendered with a deterministic short hash derived
 * from the tool name until the audit IPC starts surfacing real
 * per-tool receipt history. Phase B wires the live chain.
 */
export interface PermissionRowProps {
  row: PermissionRowType;
  onSet: (tool: string, level: PermissionLevel) => void;
  onClear: (tool: string) => void;
  pending?: boolean;
  /** First row in the list — strips the top border. */
  isFirst?: boolean;
  testId?: string;
}

const NEXT_LEVEL: Record<PermissionLevel, PermissionLevel> = {
  auto: "confirm",
  confirm: "deny",
  deny: "auto",
};

function deriveWitnessHash(name: string): string {
  // Stable short hash from the tool name (no real witness yet).
  // FNV-1a 32-bit, hex-padded — readable and deterministic per run.
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return `w_${h.toString(16).padStart(8, "0").slice(0, 7)}`;
}

export function PermissionRow({
  row,
  onSet,
  onClear,
  pending = false,
  isFirst = false,
  testId,
}: PermissionRowProps) {
  const effective = effectivePermission(row);
  const overridden = row.override_level !== null;
  const witnessHash = deriveWitnessHash(row.name);
  const [hovered, setHovered] = useState(false);

  return (
    <li
      data-testid={testId ?? `permission-row-${row.name}`}
      data-tool={row.name}
      data-overridden={overridden ? "true" : "false"}
      aria-busy={pending}
      className="relative px-1 py-3"
      style={{
        borderTop: isFirst ? "none" : "1px solid var(--border)",
        opacity: pending ? 0.7 : 1,
        transition: "opacity 150ms",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className="grid items-baseline gap-x-4 gap-y-1.5"
        style={{ gridTemplateColumns: "1fr auto" }}
      >
        <div
          className="text-[13px] truncate"
          style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}
        >
          {row.name}
        </div>
        <WitnessChip hash={witnessHash} />

        <div
          className="text-[12.5px]"
          style={{ color: "var(--text-muted)" }}
        >
          {row.description}
        </div>

        <PermissionCycler
          level={effective}
          onClick={() => onSet(row.name, NEXT_LEVEL[effective])}
          disabled={pending}
          testId={`permission-cycler-${row.name}`}
        />
      </div>

      <div
        className="text-[11.5px] mt-1.5 flex items-center gap-1.5"
        style={{ color: "var(--text-dim)" }}
      >
        <span>default</span>
        <span style={{ color: "var(--text-muted)" }}>{row.default_permission}</span>
        {overridden ? (
          <>
            <span style={{ color: "var(--text-faint)" }}>·</span>
            <span style={{ color: "var(--text-muted)" }}>
              you've overridden it to {effective}
            </span>
            <button
              type="button"
              data-testid={`permission-reset-${row.name}`}
              onClick={() => onClear(row.name)}
              disabled={pending}
              title={`Reset to default (${row.default_permission})`}
              className="inline-flex items-center gap-1 hover:text-[var(--text)] focus:outline-none disabled:opacity-30"
              style={{
                color: "var(--text-subtle)",
                opacity: hovered ? 1 : 0,
                transition: "opacity 150ms",
              }}
            >
              <RotateCcw size={10} strokeWidth={1.6} />
              <span>reset</span>
            </button>
          </>
        ) : null}
      </div>
    </li>
  );
}

interface WitnessChipProps {
  hash: string;
}

function WitnessChip({ hash }: WitnessChipProps) {
  return (
    <span
      data-testid="permission-row-witness"
      className="inline-flex items-center gap-1.5"
      style={{
        height: 22,
        padding: "0 8px 0 7px",
        borderRadius: 999,
        background:
          "linear-gradient(180deg, rgba(166,194,176,0.07), rgba(166,194,176,0.03))",
        border: "1px solid rgba(166,194,176,0.18)",
        color: "var(--verified)",
        fontSize: 11,
        lineHeight: 1,
      }}
    >
      <KeyRound size={11} strokeWidth={1.6} />
      <span style={{ color: "rgba(166,194,176,0.78)" }}>verified</span>
      <span style={{ color: "rgba(166,194,176,0.35)" }}>·</span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          color: "#C8DDD0",
          letterSpacing: "0.01em",
        }}
      >
        {hash}
      </span>
    </span>
  );
}

interface PermissionCyclerProps {
  level: PermissionLevel;
  onClick: () => void;
  disabled: boolean;
  testId: string;
}

function PermissionCycler({ level, onClick, disabled, testId }: PermissionCyclerProps) {
  const config: Record<
    PermissionLevel,
    { label: string; swatch: string; color: string; border: string }
  > = {
    auto: {
      label: "Auto",
      swatch: "var(--accent)",
      color: "var(--text)",
      border: "var(--border-strong)",
    },
    confirm: {
      label: "Confirm",
      swatch: "var(--pending)",
      color: "#E2C58B",
      border: "rgba(212,180,122,0.22)",
    },
    deny: {
      label: "Deny",
      swatch: "var(--denied)",
      color: "#E0A8A8",
      border: "rgba(208,133,133,0.22)",
    },
  };
  const { label, swatch, color, border } = config[level];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      data-level={level}
      title={`Click to cycle (next: ${nextLabel(level)})`}
      className="inline-flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        height: 26,
        padding: "0 8px 0 9px",
        borderRadius: 7,
        border: `1px solid ${border}`,
        background: "rgba(255,255,255,0.018)",
        color,
        fontSize: 12,
        letterSpacing: "-0.005em",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: swatch,
          boxShadow: "0 0 0 2px rgba(255,255,255,0.025)",
        }}
      />
      <span>{label}</span>
      <ChevronDown size={10} strokeWidth={1.8} />
    </button>
  );
}

function nextLabel(level: PermissionLevel): string {
  return {
    auto: "Confirm",
    confirm: "Deny",
    deny: "Auto",
  }[level];
}
