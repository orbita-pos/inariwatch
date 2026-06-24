/**
 * Settings → Memory
 *
 * Jarvis-layer personal fact store. Shows all stored facts grouped by type,
 * lets the user add facts manually, delete individual facts, and wipe all.
 */

import { Brain, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type FactType,
  type MemoryFact,
  type MemoryStats,
  userMemoryDelete,
  userMemoryList,
  userMemoryStats,
  userMemoryUpsert,
  userMemoryWipe,
} from "@/lib/ipc/user-memory";

import {
  Dropdown,
  GhostButton,
  SettingsGroup,
  SettingsHeader,
} from "./primitives";

// ── Constants ────────────────────────────────────────────────────────────────

const FACT_TYPES: FactType[] = ["identity", "preference", "skill", "pattern", "context"];

const FACT_TYPE_LABELS: Record<FactType, string> = {
  identity:   "Identity",
  preference: "Preferences",
  skill:      "Skills",
  pattern:    "Patterns",
  context:    "Context",
};

const FACT_TYPE_DESCRIPTIONS: Record<FactType, string> = {
  identity:   "Who you are — name, role, team.",
  preference: "How you like things done — style, tools, shortcuts.",
  skill:      "What you know — languages, frameworks, areas of expertise.",
  pattern:    "How you work — repeated approaches, tendencies.",
  context:    "What you're currently working on.",
};

// ── Main component ───────────────────────────────────────────────────────────

export function SettingsUserMemory() {
  const [facts, setFacts]       = useState<MemoryFact[]>([]);
  const [stats, setStats]       = useState<MemoryStats | null>(null);
  const [loading, setLoading]   = useState(true);
  const [showAdd, setShowAdd]   = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState(false);

  const load = useCallback(async () => {
    const [f, s] = await Promise.all([userMemoryList(), userMemoryStats()]);
    setFacts(f);
    setStats(s);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = async (id: number) => {
    await userMemoryDelete(id);
    setFacts((prev) => prev.filter((f) => f.id !== id));
    setStats((prev) => prev ? { ...prev, total_facts: prev.total_facts - 1 } : prev);
  };

  const handleWipe = async () => {
    await userMemoryWipe();
    setFacts([]);
    setStats(null);
    setWipeConfirm(false);
  };

  const handleAdded = (fact: MemoryFact) => {
    setFacts((prev) => {
      const idx = prev.findIndex((f) => f.id === fact.id);
      return idx >= 0 ? prev.map((f, i) => i === idx ? fact : f) : [...prev, fact];
    });
    setStats((prev) => prev ? { ...prev, total_facts: prev.total_facts + 1 } : prev);
    setShowAdd(false);
  };

  const grouped = FACT_TYPES.reduce<Record<FactType, MemoryFact[]>>((acc, t) => {
    acc[t] = facts.filter((f) => f.fact_type === t);
    return acc;
  }, {} as Record<FactType, MemoryFact[]>);

  return (
    <section data-testid="settings-section-memory" className="flex flex-col">
      <SettingsHeader
        title="Memory"
        description="Facts the AI remembers about you across sessions. Injected as context in every conversation."
      />

      {/* Stats bar */}
      {stats ? (
        <div
          className="mt-5 flex items-center gap-4 flex-wrap"
          style={{
            padding: "10px 14px",
            background: "rgba(255,255,255,0.018)",
            border: "1px solid var(--border)",
            borderRadius: 9,
            fontSize: 12,
            color: "var(--text-subtle)",
          }}
        >
          <StatChip label="total" value={stats.total_facts} />
          <StatChip label="identity" value={stats.by_identity} />
          <StatChip label="preferences" value={stats.by_preference} />
          <StatChip label="skills" value={stats.by_skill} />
          <StatChip label="patterns" value={stats.by_pattern} />
          <StatChip label="context" value={stats.by_context} />
          <div className="ml-auto flex items-center gap-2">
            <Brain size={11} strokeWidth={1.5} style={{ color: "var(--accent)" }} />
            <span style={{ color: "var(--accent)", fontSize: 11 }}>active</span>
          </div>
        </div>
      ) : null}

      <div className="mt-6" />

      {/* Add fact form */}
      {showAdd ? (
        <AddFactForm onAdded={handleAdded} onCancel={() => setShowAdd(false)} />
      ) : (
        <div className="mb-5">
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            data-testid="memory-add-fact"
            className="inline-flex items-center gap-2 transition-colors hover:bg-white/[0.025]"
            style={{
              height: 30,
              padding: "0 12px",
              borderRadius: 8,
              background: "transparent",
              color: "var(--text-muted)",
              border: "1px solid var(--border-strong)",
              fontSize: 12.5,
              letterSpacing: "-0.005em",
            }}
          >
            <Plus size={11} strokeWidth={2} />
            Add fact
          </button>
        </div>
      )}

      {/* Fact groups */}
      {loading ? (
        <div className="text-[12.5px]" style={{ color: "var(--text-dim)" }}>Loading…</div>
      ) : facts.length === 0 ? (
        <EmptyState />
      ) : (
        FACT_TYPES.map((type) => {
          const group = grouped[type];
          if (group.length === 0) return null;
          return (
            <SettingsGroup
              key={type}
              eyebrow={FACT_TYPE_LABELS[type]}
              description={FACT_TYPE_DESCRIPTIONS[type]}
            >
              {group.map((fact) => (
                <FactRow key={fact.id} fact={fact} onDelete={handleDelete} />
              ))}
            </SettingsGroup>
          );
        })
      )}

      {/* Danger zone */}
      {facts.length > 0 ? (
        <div className="mt-4">
          {wipeConfirm ? (
            <div
              className="p-4"
              style={{
                background: "rgba(208,133,133,0.03)",
                border: "1px solid rgba(208,133,133,0.28)",
                borderRadius: 9,
              }}
            >
              <p className="text-[13px] mb-3" style={{ color: "var(--text-subtle)" }}>
                This will permanently erase all {facts.length} stored facts. The AI will
                start fresh next session.
              </p>
              <div className="flex gap-2">
                <GhostButton testId="memory-wipe-confirm" destructive onClick={handleWipe}>
                  Yes, clear everything
                </GhostButton>
                <GhostButton testId="memory-wipe-cancel" onClick={() => setWipeConfirm(false)}>
                  Cancel
                </GhostButton>
              </div>
            </div>
          ) : (
            <GhostButton
              testId="memory-wipe"
              destructive
              onClick={() => setWipeConfirm(true)}
            >
              Clear all memory
            </GhostButton>
          )}
        </div>
      ) : null}
    </section>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────────

function StatChip({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex items-center gap-1">
      <span style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{value}</span>
      <span>{label}</span>
    </span>
  );
}

function FactRow({
  fact,
  onDelete,
}: {
  fact: MemoryFact;
  onDelete: (id: number) => void;
}) {
  const confidence = Math.round(fact.confidence * 100);
  return (
    <div
      className="flex items-center gap-3"
      style={{
        padding: "8px 0",
        borderTop: "1px solid var(--border)",
      }}
    >
      <div className="flex-1 min-w-0">
        <span className="text-[13px] truncate block" style={{ color: "var(--text)" }}>
          {fact.content}
        </span>
        <span
          className="text-[11px]"
          style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}
        >
          {fact.source.toLowerCase()} · {confidence}%
        </span>
      </div>
      <button
        type="button"
        onClick={() => onDelete(fact.id)}
        data-testid={`memory-delete-${fact.id}`}
        aria-label={`Delete fact: ${fact.content}`}
        className="shrink-0 transition-opacity opacity-40 hover:opacity-100"
        style={{ color: "var(--text-dim)", padding: 4 }}
      >
        <X size={12} strokeWidth={1.8} />
      </button>
    </div>
  );
}

function AddFactForm({
  onAdded,
  onCancel,
}: {
  onAdded: (fact: MemoryFact) => void;
  onCancel: () => void;
}) {
  const [type, setType]       = useState<FactType>("identity");
  const [content, setContent] = useState("");
  const [saving, setSaving]   = useState(false);
  const inputRef              = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSave = async () => {
    const trimmed = content.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const fact = await userMemoryUpsert({
        fact_type:  type,
        content:    trimmed,
        confidence: 1.0,
        source:     "explicit",
      });
      onAdded(fact);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="mb-5 p-4"
      style={{
        background: "rgba(255,255,255,0.018)",
        border: "1px solid var(--border-strong)",
        borderRadius: 9,
      }}
    >
      <div className="flex items-center gap-3 mb-3">
        <Dropdown<FactType>
          options={FACT_TYPES.map((t) => ({ value: t, label: FACT_TYPE_LABELS[t] }))}
          value={type}
          onChange={setType}
          testId="memory-add-type"
          minWidth={130}
        />
        <input
          ref={inputRef}
          type="text"
          value={content}
          placeholder="Describe this fact about yourself…"
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSave();
            if (e.key === "Escape") onCancel();
          }}
          data-testid="memory-add-content"
          className="flex-1 outline-none transition-colors"
          style={{
            height: 30,
            padding: "0 10px",
            background: "rgba(255,255,255,0.018)",
            border: "1px solid var(--border-strong)",
            borderRadius: 8,
            color: "var(--text)",
            fontSize: 12.5,
            letterSpacing: "-0.005em",
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = "var(--border-3)"; }}
          onBlur={(e)  => { e.currentTarget.style.borderColor = "var(--border-strong)"; }}
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !content.trim()}
          data-testid="memory-add-save"
          className="transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            height: 28,
            padding: "0 12px",
            borderRadius: 7,
            background: "var(--accent)",
            color: "var(--accent-ink)",
            border: "none",
            fontSize: 12,
            letterSpacing: "-0.005em",
            cursor: "pointer",
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <GhostButton onClick={onCancel} testId="memory-add-cancel">Cancel</GhostButton>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="flex flex-col items-center justify-center py-12 gap-3"
      style={{ color: "var(--text-dim)" }}
    >
      <Brain size={28} strokeWidth={1.2} style={{ opacity: 0.35 }} />
      <p className="text-[13px] text-center" style={{ maxWidth: 280, lineHeight: 1.5 }}>
        No facts stored yet. The AI learns from your messages automatically, or
        you can add facts manually above.
      </p>
    </div>
  );
}
