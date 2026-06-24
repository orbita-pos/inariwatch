/**
 * Shared primitives for the Settings sub-section template.
 *
 * Per the 2026-05-08 design pivot: every sub-section (General / AI /
 * Permissions / Voice / Notifications / Privacy / etc.) renders as a
 * stack of `SettingsGroup`s, each with an eyebrow + description +
 * `SettingsField` rows. Field controls (Toggle / Segmented /
 * Dropdown / TextInput) come from this file so the visual language
 * stays uniform across all 12 sub-sections.
 */

import { Check, ChevronDown } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";

// ── Section primitives ──────────────────────────────────────────────────────

export function SettingsHeader({
  title,
  description,
}: {
  title: string;
  description?: ReactNode;
}) {
  return (
    <header className="mb-1">
      <h2
        className="text-[22px] font-light tracking-[-0.018em]"
        style={{ color: "var(--text)" }}
      >
        {title}
      </h2>
      {description ? (
        <p className="text-[13px] mt-1.5" style={{ color: "var(--text-subtle)" }}>
          {description}
        </p>
      ) : null}
    </header>
  );
}

interface SettingsGroupProps {
  eyebrow: string;
  description?: ReactNode;
  children: ReactNode;
  /** Renders a soft-red border + tint to mark a destructive section. */
  danger?: boolean;
}

export function SettingsGroup({
  eyebrow,
  description,
  children,
  danger = false,
}: SettingsGroupProps) {
  if (danger) {
    return (
      <div
        className="mt-5 p-4"
        style={{
          background: "rgba(208,133,133,0.03)",
          border: "1px solid rgba(208,133,133,0.28)",
          borderRadius: 9,
        }}
      >
        <div
          className="text-[11px] font-medium"
          style={{
            color: "var(--danger)",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            marginBottom: 12,
          }}
        >
          {eyebrow}
        </div>
        {description ? (
          <p
            className="text-[12.5px]"
            style={{ color: "var(--text-subtle)", marginBottom: 10, lineHeight: 1.5 }}
          >
            {description}
          </p>
        ) : null}
        <div>{children}</div>
      </div>
    );
  }
  return (
    <div className="mb-6">
      <div
        className="text-[10.5px] font-medium"
        style={{
          color: "var(--text-dim)",
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          marginBottom: 3,
        }}
      >
        {eyebrow}
      </div>
      {description ? (
        <p
          className="text-[12.5px]"
          style={{
            color: "var(--text-subtle)",
            lineHeight: 1.5,
            marginBottom: 10,
          }}
        >
          {description}
        </p>
      ) : null}
      <div>{children}</div>
    </div>
  );
}

interface SettingsFieldProps {
  label: ReactNode;
  helper?: ReactNode;
  control: ReactNode;
  /** When set, renders a small saved chip next to the control. */
  saved?: boolean;
  /** First field of a group — strips the top hairline. */
  first?: boolean;
}

export function SettingsField({
  label,
  helper,
  control,
  saved = false,
  first = false,
}: SettingsFieldProps) {
  return (
    <div
      className="grid items-center"
      style={{
        gridTemplateColumns: "1fr auto",
        gap: 12,
        padding: "11px 0",
        borderTop: first ? "none" : "1px solid var(--border)",
      }}
    >
      <div>
        <div className="text-[13.5px]" style={{ color: "var(--text)", letterSpacing: "-0.005em" }}>
          {label}
        </div>
        {helper ? (
          <div
            className="text-[12px]"
            style={{ color: "var(--text-subtle)", marginTop: 2, lineHeight: 1.45 }}
          >
            {helper}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        {saved ? <SavedChip /> : null}
        {control}
      </div>
    </div>
  );
}

function SavedChip() {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{
        color: "var(--success-2)",
        fontSize: 11,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 5,
          height: 5,
          borderRadius: 999,
          background: "var(--verified)",
        }}
      />
      saved
    </span>
  );
}

// ── Controls ────────────────────────────────────────────────────────────────

interface ToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  testId?: string;
}

export function Toggle({ on, onChange, disabled, ariaLabel, testId }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      data-testid={testId}
      data-on={on ? "true" : "false"}
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      className="relative shrink-0 transition-[background] duration-150 disabled:opacity-[0.38] disabled:cursor-not-allowed"
      style={{
        width: 32,
        height: 18,
        borderRadius: 999,
        background: on ? "var(--accent)" : "var(--surface-3)",
        border: on ? "1px solid var(--accent)" : "1px solid var(--border-strong)",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 2,
          left: on ? 16 : 2,
          width: 12,
          height: 12,
          borderRadius: 999,
          background: on ? "var(--accent-ink)" : "var(--text-dim)",
          transition: "left 150ms ease, background 150ms",
        }}
      />
    </button>
  );
}

interface SegmentedProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  testId?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
  testId,
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      data-testid={testId}
      className="inline-flex gap-0.5"
      style={{
        background: "rgba(255,255,255,0.022)",
        border: "1px solid var(--border-strong)",
        borderRadius: 9,
        padding: 2,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className="transition-colors"
            style={{
              height: 26,
              padding: "0 11px",
              borderRadius: 6,
              fontSize: 12,
              color: active ? "var(--text)" : "var(--text-muted)",
              background: active ? "rgba(255,255,255,0.05)" : "transparent",
              boxShadow: active ? "inset 0 0 0 1px rgba(255,255,255,0.05)" : undefined,
              letterSpacing: "-0.005em",
              cursor: disabled ? "not-allowed" : "pointer",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

interface DropdownOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface DropdownProps<T extends string> {
  options: ReadonlyArray<DropdownOption<T>>;
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  testId?: string;
  /** Min-width override for narrow values. */
  minWidth?: number;
}

export function Dropdown<T extends string>({
  options,
  value,
  onChange,
  disabled,
  testId,
  minWidth,
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid={testId}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className="inline-flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/[0.025]"
        style={{
          height: 30,
          padding: "0 10px 0 12px",
          background: "rgba(255,255,255,0.018)",
          border: "1px solid var(--border-strong)",
          borderRadius: 8,
          color: "var(--text)",
          fontSize: 12.5,
          letterSpacing: "-0.005em",
          minWidth,
        }}
      >
        <span>{selected?.label ?? "—"}</span>
        <ChevronDown size={11} strokeWidth={1.7} style={{ color: "var(--text-subtle)" }} />
      </button>
      {open ? (
        <div
          role="listbox"
          className="absolute z-30 mt-1.5"
          style={{
            top: "100%",
            right: 0,
            minWidth: minWidth ?? 200,
            background: "#131318",
            border: "1px solid var(--border-strong)",
            borderRadius: 10,
            padding: 6,
            boxShadow:
              "0 16px 40px -8px rgba(0,0,0,0.7), 0 4px 12px -2px rgba(0,0,0,0.4)",
          }}
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className="w-full flex items-center px-2.5 transition-colors hover:bg-white/[0.025]"
                style={{
                  height: 30,
                  borderRadius: 6,
                  background: active ? "rgba(255,255,255,0.04)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  fontSize: 13,
                  textAlign: "left",
                }}
              >
                <span className="flex-1 truncate">{opt.label}</span>
                {active ? (
                  <Check
                    size={11}
                    strokeWidth={2}
                    style={{ color: "var(--accent)", marginLeft: 8 }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

interface TextInputProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: "text" | "time";
  disabled?: boolean;
  width?: number;
  mono?: boolean;
  testId?: string;
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
  width,
  mono = false,
  testId,
}: TextInputProps) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      data-testid={testId}
      disabled={disabled}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      className="outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        height: 30,
        padding: "0 10px",
        background: "rgba(255,255,255,0.018)",
        border: "1px solid var(--border-strong)",
        borderRadius: 8,
        color: "var(--text)",
        fontSize: 12.5,
        letterSpacing: mono ? "0.02em" : "-0.005em",
        fontFamily: mono ? "var(--font-mono)" : undefined,
        width,
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderColor = "var(--border-3)";
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = "var(--border-strong)";
      }}
    />
  );
}

// ── Read-only kv row (Privacy, About, etc.) ─────────────────────────────────

export function KvRow({
  k,
  v,
  mono = false,
}: {
  k: ReactNode;
  v: ReactNode;
  mono?: boolean;
}) {
  return (
    <div
      className="grid items-baseline py-1.5"
      style={{ gridTemplateColumns: "180px 1fr", gap: 12 }}
    >
      <span className="text-[12.5px]" style={{ color: "var(--text-dim)" }}>
        {k}
      </span>
      <span
        className="text-[13px]"
        style={{
          color: "var(--text)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
        }}
      >
        {v}
      </span>
    </div>
  );
}

// ── Buttons ─────────────────────────────────────────────────────────────────

export function GhostButton({
  children,
  onClick,
  testId,
  destructive = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  testId?: string;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="transition-colors hover:bg-white/[0.025]"
      style={{
        height: 30,
        padding: "0 12px",
        borderRadius: 8,
        background: "transparent",
        color: destructive ? "var(--denied)" : "var(--text-muted)",
        border: `1px solid ${destructive ? "rgba(208,133,133,0.22)" : "var(--border-strong)"}`,
        fontSize: 12.5,
        letterSpacing: "-0.005em",
      }}
    >
      {children}
    </button>
  );
}
