"use client";

import { useState, useTransition } from "react";
import { Download, Loader2, AlertCircle } from "lucide-react";

interface OrgOption {
  id: string;
  name: string;
}

interface StandardOption {
  id: string;
  label: string;
  full: string;
  controlCount: number;
}

interface AuditExportFormProps {
  organizations: OrgOption[];
  standards: StandardOption[];
  plan: string;
}

function defaultStartDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}

function defaultEndDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function AuditExportForm({
  organizations,
  standards,
}: AuditExportFormProps) {
  const [orgId, setOrgId] = useState<string>(""); // "" = personal workspace
  const [standardId, setStandardId] = useState<string>(standards[0]?.id ?? "soc2");
  const [startDate, setStartDate] = useState<string>(defaultStartDate());
  const [endDate, setEndDate] = useState<string>(defaultEndDate());
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    receipts: number;
    signed: number;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    startTransition(async () => {
      try {
        const res = await fetch("/api/audit-export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: orgId === "" ? null : orgId,
            standard: standardId,
            startDate: new Date(startDate + "T00:00:00Z").toISOString(),
            endDate: new Date(endDate + "T23:59:59Z").toISOString(),
          }),
        });

        if (!res.ok) {
          let msg = `Export failed (${res.status})`;
          try {
            const data = (await res.json()) as { error?: string };
            if (data.error) msg = data.error;
          } catch {
            // body wasn't JSON — fall through with the status text
          }
          setError(msg);
          return;
        }

        const receipts = Number(res.headers.get("x-receipt-count") ?? 0);
        const signed = Number(res.headers.get("x-signed-count") ?? 0);

        const blob = await res.blob();
        const cd = res.headers.get("content-disposition") ?? "";
        const match = cd.match(/filename="?([^";]+)"?/);
        const filename = match?.[1] ?? `inariwatch-${standardId}.zip`;

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setSuccess({ receipts, signed });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
      }
    });
  };

  const selectedStandard = standards.find((s) => s.id === standardId);

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-line bg-surface px-5 py-5 space-y-5"
    >
      <div className="space-y-1.5">
        <label
          htmlFor="audit-export-org"
          className="block text-xs font-medium text-fg-base"
        >
          Workspace
        </label>
        <select
          id="audit-export-org"
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          className="block w-full rounded-lg border border-line bg-surface-inner px-3 py-2 text-sm text-fg-base focus:border-inari-accent focus:outline-none"
        >
          <option value="">Personal workspace</option>
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="audit-export-standard"
          className="block text-xs font-medium text-fg-base"
        >
          Standard
        </label>
        <select
          id="audit-export-standard"
          value={standardId}
          onChange={(e) => setStandardId(e.target.value)}
          className="block w-full rounded-lg border border-line bg-surface-inner px-3 py-2 text-sm text-fg-base focus:border-inari-accent focus:outline-none"
        >
          {standards.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label} — {s.full}
            </option>
          ))}
        </select>
        {selectedStandard && (
          <p className="text-[11px] text-fg-base/50">
            Maps each receipt to {selectedStandard.controlCount} controls.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label
            htmlFor="audit-export-start"
            className="block text-xs font-medium text-fg-base"
          >
            From (UTC)
          </label>
          <input
            id="audit-export-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            max={endDate}
            className="block w-full rounded-lg border border-line bg-surface-inner px-3 py-2 text-sm text-fg-base focus:border-inari-accent focus:outline-none"
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="audit-export-end"
            className="block text-xs font-medium text-fg-base"
          >
            To (UTC)
          </label>
          <input
            id="audit-export-end"
            type="date"
            value={endDate}
            min={startDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="block w-full rounded-lg border border-line bg-surface-inner px-3 py-2 text-sm text-fg-base focus:border-inari-accent focus:outline-none"
          />
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-400"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          Bundled {success.receipts} receipt{success.receipts === 1 ? "" : "s"}
          {success.signed > 0 ? ` (${success.signed} signed)` : ""}. The
          download started — keep the ZIP unmodified for auditors.
        </div>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-inari-accent px-4 py-2 text-sm font-medium text-white hover:bg-inari-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Building bundle…
          </>
        ) : (
          <>
            <Download className="h-4 w-4" aria-hidden="true" />
            Generate &amp; download ZIP
          </>
        )}
      </button>
    </form>
  );
}
