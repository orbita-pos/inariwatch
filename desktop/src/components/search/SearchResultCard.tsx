/**
 * Single result row inside the SearchPanel.
 *
 * 2026-05-08 design pivot: the row is now a flat hairline list item
 * (no card outline, no surface bg). The source identity reads via a
 * tiny brand-colored dot + 2-letter tag pinned at the start of the
 * row; meta lives in inline chips; the destination URL trails as a
 * mono link with an external-link arrow.
 */

import { ArrowUpRight, Check } from "lucide-react";
import type { ReactNode } from "react";

import {
  type Hit,
  type HitMeta,
  openInBrowser,
  sourceLabel,
  type SourceTag,
} from "@/lib/inari-search-ipc";

interface SearchResultCardProps {
  hit: Hit;
  onOpen?: (url: string) => void;
}

const SOURCE_BRAND: Record<SourceTag, { color: string; tag: string }> = {
  stack_overflow: { color: "#F48024", tag: "SO" },
  github:         { color: "#B5B2AB", tag: "GH" },
  mdn:            { color: "#4D6BFE", tag: "MDN" },
};

export function SearchResultCard({ hit, onOpen }: SearchResultCardProps) {
  const handleOpen = () => {
    if (onOpen) {
      onOpen(hit.url);
      return;
    }
    void openInBrowser(hit.url);
  };

  const brand = SOURCE_BRAND[hit.source];
  const friendlyUrl = stripUrlScheme(hit.url);

  return (
    <article
      data-testid={`search-result-${hit.source}`}
      data-source={hit.source}
      className="grid items-baseline gap-x-3 px-1 py-3.5"
      style={{
        gridTemplateColumns: "44px 1fr",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div className="pt-0.5">
        <SourceTag color={brand.color} tag={brand.tag} fullName={sourceLabel(hit.source)} />
      </div>
      <div className="min-w-0">
        <button
          type="button"
          onClick={handleOpen}
          className="text-left text-[14.5px] leading-[1.4] font-medium hover:text-[var(--accent)] transition-colors"
          style={{ color: "var(--text)", letterSpacing: "-0.005em" }}
          data-testid="search-result-title"
        >
          <span className="line-clamp-2">{hit.title || "(untitled)"}</span>
        </button>

        {hit.excerpt ? (
          <p
            className="text-[12.5px] leading-[1.55] mt-1.5 line-clamp-2"
            style={{ color: "var(--text-muted)" }}
            data-testid="search-result-excerpt"
          >
            {hit.excerpt}
          </p>
        ) : null}

        <MetaChips meta={hit.meta} />

        <button
          type="button"
          onClick={handleOpen}
          className="inline-flex items-center gap-1 mt-2 text-[11.5px] hover:text-[var(--text)] transition-colors group"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--text-subtle)",
          }}
          data-testid="search-result-open"
          aria-label="Open in browser"
        >
          <span className="truncate max-w-[480px]">{friendlyUrl}</span>
          <ArrowUpRight
            size={11}
            strokeWidth={1.7}
            style={{ color: "var(--text-faint)" }}
            className="group-hover:text-[var(--text-subtle)] transition-colors"
          />
        </button>
      </div>
    </article>
  );
}

interface SourceTagProps {
  color: string;
  tag: string;
  fullName: string;
}

function SourceTag({ color, tag, fullName }: SourceTagProps) {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={fullName}
      aria-label={`Source: ${fullName}`}
      style={{
        color,
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        letterSpacing: "0.06em",
        fontWeight: 500,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: color,
          boxShadow: "0 0 0 2px rgba(255,255,255,0.025)",
        }}
      />
      {tag}
    </span>
  );
}

function MetaChips({ meta }: { meta: HitMeta }) {
  switch (meta.source) {
    case "stack_overflow":
      return (
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {meta.is_accepted ? (
            <Chip data-testid="meta-accepted" tone="sage">
              <Check size={9} strokeWidth={2.4} />
              accepted
            </Chip>
          ) : null}
          {meta.is_accepted ? <Sep /> : null}
          <Chip data-testid="meta-votes">{meta.vote_count} votes</Chip>
          <Sep />
          <Chip data-testid="meta-answers">
            {meta.answer_count} answer{meta.answer_count === 1 ? "" : "s"}
          </Chip>
        </div>
      );
    case "github":
      return (
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {meta.reaction_count > 0 ? (
            <>
              <Chip data-testid="meta-reactions">
                {meta.reaction_count} reactions
              </Chip>
              <Sep />
            </>
          ) : null}
          {meta.comment_count > 0 ? (
            <>
              <Chip data-testid="meta-comments">
                {meta.comment_count} comments
              </Chip>
              <Sep />
            </>
          ) : null}
          <Chip
            data-testid="meta-state"
            tone={meta.state === "closed" ? "muted" : "sage"}
          >
            {meta.state}
          </Chip>
        </div>
      );
    case "mdn":
      return meta.is_deprecated ? (
        <div className="flex items-center gap-1.5 mt-2">
          <Chip data-testid="meta-deprecated" tone="red">
            deprecated
          </Chip>
        </div>
      ) : null;
  }
}

interface ChipProps {
  children: ReactNode;
  tone?: "neutral" | "sage" | "red" | "muted";
  "data-testid"?: string;
}

function Chip({ children, tone = "neutral", ...rest }: ChipProps) {
  const palette =
    tone === "sage"
      ? { bg: "rgba(166,194,176,0.07)", border: "rgba(166,194,176,0.18)", color: "var(--verified)" }
      : tone === "red"
        ? { bg: "rgba(208,133,133,0.07)", border: "rgba(208,133,133,0.22)", color: "#E0A8A8" }
        : tone === "muted"
          ? { bg: "transparent", border: "var(--border)", color: "var(--text-subtle)" }
          : { bg: "transparent", border: "transparent", color: "var(--text-subtle)" };
  return (
    <span
      data-testid={rest["data-testid"]}
      className="inline-flex items-center gap-1"
      style={{
        height: 18,
        padding: tone === "neutral" ? "0" : "0 7px",
        borderRadius: 999,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.color,
        fontSize: 11,
        lineHeight: 1,
      }}
    >
      {children}
    </span>
  );
}

function Sep() {
  return (
    <span style={{ color: "var(--text-faint)", fontSize: 11 }} aria-hidden>
      ·
    </span>
  );
}

function stripUrlScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
