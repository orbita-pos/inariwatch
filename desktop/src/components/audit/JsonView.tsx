import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";

/**
 * Minimal recursive JSON viewer (~80 LOC). NO external library —
 * `react-json-view` is AGPL and ships ~50KB; we don't need its
 * editing UI. Renders objects + arrays with collapse/expand
 * disclosure rows, primitives inline. Keys + values colour-coded via
 * the existing tokens (no new colors introduced).
 *
 * The viewer ignores prototype-poisoning concerns by reading only
 * `Object.keys(value)` (own-enumerable strings) — adequate for
 * `serde_json::Value`-shaped trees, which is the only thing the
 * audit-log surface ever feeds it.
 */
export interface JsonViewProps {
  /** Root JSON value. May be a string (parsed), object/array/primitive. */
  value: unknown;
  /** Initial depth at which subtrees render collapsed. Defaults to 1
   *  so the top-level object is open but children fold. */
  defaultExpandDepth?: number;
  className?: string;
  testId?: string;
}

export function JsonView({
  value,
  defaultExpandDepth = 1,
  className,
  testId,
}: JsonViewProps) {
  // Accept JSON-encoded strings transparently — the audit log stores
  // args/result as TEXT, so the viewer is the natural place to parse.
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      // Fall back to rendering the raw string. The user gets to see
      // exactly what was stored, including malformed JSON.
      parsed = value;
    }
  }

  return (
    <div
      data-testid={testId ?? "json-view"}
      className={cn(
        "font-mono text-[12px] leading-relaxed text-[var(--text)]",
        "whitespace-pre-wrap break-words",
        className,
      )}
    >
      <Node value={parsed} depth={0} maxDepth={defaultExpandDepth} />
    </div>
  );
}

interface NodeProps {
  value: unknown;
  depth: number;
  maxDepth: number;
  /** Optional key label for object members (renders `"key":` prefix). */
  label?: string;
}

function Node({ value, depth, maxDepth, label }: NodeProps) {
  if (value === null) {
    return <Primitive label={label} className="text-[var(--text-subtle)]">null</Primitive>;
  }
  if (typeof value === "boolean") {
    return (
      <Primitive label={label} className="text-[var(--accent)]">
        {String(value)}
      </Primitive>
    );
  }
  if (typeof value === "number") {
    return (
      <Primitive label={label} className="text-[var(--accent-light)]">
        {String(value)}
      </Primitive>
    );
  }
  if (typeof value === "string") {
    return (
      <Primitive label={label} className="text-[var(--success)]">
        {JSON.stringify(value)}
      </Primitive>
    );
  }
  if (Array.isArray(value)) {
    return (
      <Container
        label={label}
        depth={depth}
        maxDepth={maxDepth}
        open={["[", "]"]}
        empty="[]"
        entries={value.map((v, i) => ({ key: String(i), value: v }))}
        showKeys={false}
      />
    );
  }
  if (typeof value === "object") {
    const entries = Object.keys(value).map((k) => ({
      key: k,
      value: (value as Record<string, unknown>)[k],
    }));
    return (
      <Container
        label={label}
        depth={depth}
        maxDepth={maxDepth}
        open={["{", "}"]}
        empty="{}"
        entries={entries}
        showKeys
      />
    );
  }
  return (
    <Primitive label={label} className="text-[var(--text-muted)]">
      {String(value)}
    </Primitive>
  );
}

interface PrimitiveProps {
  label?: string;
  className?: string;
  children: React.ReactNode;
}

function Primitive({ label, className, children }: PrimitiveProps) {
  return (
    <div className="pl-4">
      {label !== undefined ? (
        <span className="text-[var(--text-muted)]">{`"${label}": `}</span>
      ) : null}
      <span className={className}>{children}</span>
    </div>
  );
}

interface ContainerProps {
  label?: string;
  depth: number;
  maxDepth: number;
  open: [string, string];
  empty: string;
  entries: Array<{ key: string; value: unknown }>;
  showKeys: boolean;
}

function Container({
  label,
  depth,
  maxDepth,
  open,
  empty,
  entries,
  showKeys,
}: ContainerProps) {
  const [isOpen, setIsOpen] = useState(depth < maxDepth);
  if (entries.length === 0) {
    return (
      <Primitive label={label} className="text-[var(--text-muted)]">
        {empty}
      </Primitive>
    );
  }
  const Icon = isOpen ? ChevronDown : ChevronRight;
  return (
    <div>
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
        className={cn(
          "inline-flex items-center gap-1 cursor-pointer rounded-sm",
          "text-[var(--text-muted)] hover:text-[var(--text)]",
          "transition-colors duration-[var(--duration-fast)]",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        )}
      >
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        {label !== undefined ? <span>{`"${label}":`}</span> : null}
        <span>{open[0]}</span>
        {!isOpen ? (
          <span className="text-[var(--text-subtle)]">
            {`${entries.length} ${entries.length === 1 ? "entry" : "entries"}`}
          </span>
        ) : null}
        {!isOpen ? <span>{open[1]}</span> : null}
      </button>
      {isOpen ? (
        <div className="border-l border-[var(--border-subtle)] ml-1.5">
          {entries.map((e) => (
            <Node
              key={e.key}
              value={e.value}
              depth={depth + 1}
              maxDepth={maxDepth}
              label={showKeys ? e.key : undefined}
            />
          ))}
          <div className="pl-4 text-[var(--text-muted)]">{open[1]}</div>
        </div>
      ) : null}
    </div>
  );
}
