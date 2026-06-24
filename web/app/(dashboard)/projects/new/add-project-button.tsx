"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Download, Laptop, Loader2, Plus, Wrench } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { addProjectFromRepo } from "../../import/actions";

/**
 * Add Project picker button — Inari Live V1 Session 3 + Session 4.
 *
 * Calls the existing /import server action (the underlying logic is
 * shared) and renders a status pill that maps the `wizardDelivery`
 * field into user-facing copy:
 *
 *   * `delivered`        → "Wizard opening in Inari Live…"
 *   * `sidecar_offline`  → "Open Inari Live to continue"
 *   * `relay_disabled`   → "Project added — finish in dashboard"
 *   * `not_emitted`      → "Already wired up"
 *   * `error`            → red text + retry
 *
 * S4 — every post-add state surfaces a secondary "Manual setup" link
 * to the new `/dashboard/projects/[slug]/manual-setup` page so users
 * without (or who don't want) Inari Live still have a 1-click path to
 * their first event. The download CTA points at the marketing page;
 * the manual setup deep-links the project's slug.
 */
export function AddProjectButton({
  installationId,
  owner,
  repo,
}: {
  installationId: number;
  owner:          string;
  repo:           string;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [status, setStatus] = useState<
    | "idle"
    | "delivered"
    | "sidecar_offline"
    | "relay_disabled"
    | "added"
    | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(null);

  if (status === "delivered") {
    return <PostAddBranchPoint slug={slug} variant="delivered" />;
  }
  if (status === "sidecar_offline") {
    return <PostAddBranchPoint slug={slug} variant="sidecar_offline" />;
  }
  if (status === "relay_disabled" || status === "added") {
    return <PostAddBranchPoint slug={slug} variant="added" />;
  }

  return (
    <div className="flex items-center gap-2">
      {errorMsg && (
        <span className="text-[11px] text-red-500" title={errorMsg}>
          {errorMsg.slice(0, 32)}…
        </span>
      )}
      <Button
        variant="primary"
        size="sm"
        className="gap-1.5"
        disabled={isPending}
        onClick={() => {
          setErrorMsg(null);
          start(async () => {
            const r = await addProjectFromRepo(installationId, owner, repo);
            if (r.error) {
              setStatus("error");
              setErrorMsg(r.error);
              return;
            }
            setSlug(r.slug ?? null);
            switch (r.wizardDelivery) {
              case "delivered":
                setStatus("delivered");
                break;
              case "sidecar_offline":
                setStatus("sidecar_offline");
                break;
              case "relay_disabled":
                setStatus("relay_disabled");
                break;
              case "not_emitted":
              default:
                setStatus("added");
                break;
            }
            router.refresh();
          });
        }}
      >
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        Add
      </Button>
    </div>
  );
}

// ── Session 4 — branch point ────────────────────────────────────────────────

type BranchVariant = "delivered" | "sidecar_offline" | "added";

/**
 * Compact two-CTA panel rendered after Add succeeds. Always surfaces
 * BOTH paths so neither is hidden behind a menu. The primary CTA
 * shifts based on variant:
 *
 *   * delivered       — "Continue in Inari Live" (already opened locally)
 *   * sidecar_offline — "Install Inari Live"     (download for OS)
 *   * added           — "Open project"           (relay disabled / OSS env)
 *
 * Secondary is always "Manual setup" → the new S4 page. The "View →"
 * deep link survives at the very end so existing muscle memory keeps
 * working.
 */
function PostAddBranchPoint({
  slug,
  variant,
}: {
  slug: string | null;
  variant: BranchVariant;
}) {
  const primary = primaryCta(variant);
  return (
    <div className="flex flex-col items-end gap-1.5 text-[12px]">
      <div className="flex items-center gap-2">
        {primary.kind === "external" ? (
          <a
            href={primary.href}
            target={primary.newTab ? "_blank" : undefined}
            rel={primary.newTab ? "noopener noreferrer" : undefined}
            className="inline-flex items-center gap-1.5 rounded-md border border-inari-accent/30 bg-inari-accent/[0.06] px-2.5 py-1 font-medium text-inari-accent hover:bg-inari-accent/[0.1] transition-colors"
          >
            {primary.icon === "Laptop" ? (
              <Laptop className="h-3.5 w-3.5" aria-hidden="true" />
            ) : primary.icon === "Download" ? (
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {primary.label}
          </a>
        ) : slug ? (
          <Link
            href={primary.href.replace("{slug}", slug)}
            className="inline-flex items-center gap-1.5 rounded-md border border-inari-accent/30 bg-inari-accent/[0.06] px-2.5 py-1 font-medium text-inari-accent hover:bg-inari-accent/[0.1] transition-colors"
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            {primary.label}
          </Link>
        ) : null}

        {slug ? (
          <Link
            href={`/projects/${slug}/manual-setup`}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-fg-base/70 hover:text-fg-strong hover:bg-surface-dim/40 transition-colors"
          >
            <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
            Manual setup
          </Link>
        ) : null}
      </div>
      {slug ? (
        <Link
          href={`/projects/${slug}`}
          className="text-[11px] text-fg-base/40 hover:text-fg-base/70"
        >
          View →
        </Link>
      ) : null}
    </div>
  );
}

type PrimaryCta =
  | { kind: "external"; href: string; label: string; icon: "Laptop" | "Download" | "Check"; newTab: boolean }
  | { kind: "internal"; href: string; label: string };

function primaryCta(variant: BranchVariant): PrimaryCta {
  switch (variant) {
    case "delivered":
      return {
        kind:   "external",
        href:   "inariwatch://wizard", // best-effort deeplink; falls back to no-op
        label:  "Continue in Inari Live",
        icon:   "Laptop",
        newTab: false,
      };
    case "sidecar_offline":
      return {
        kind:   "external",
        href:   "https://app.inariwatch.com/download",
        label:  "Install Inari Live",
        icon:   "Download",
        newTab: true,
      };
    case "added":
    default:
      return {
        kind:  "internal",
        href:  "/projects/{slug}",
        label: "Open project",
      };
  }
}
