"use client";

/**
 * Sesión 30 — three OS download buttons with UA-detected primary.
 *
 * Buttons remain DISABLED ("Beta — coming this month") until S32 publishes
 * signed binaries to releases.inariwatch.com. When that happens, flip
 * BINARIES_AVAILABLE to true and replace the placeholder `href` values
 * with the real R2 download URLs.
 *
 * TODO(S32): set BINARIES_AVAILABLE=true and wire real R2 URLs once
 *            the release pipeline (S31 signing + S32 R2 upload) lands.
 */

import { useEffect, useState } from "react";

type OS = "mac" | "windows" | "linux" | "unknown";

const BINARIES_AVAILABLE = false;

interface ButtonSpec {
  os: Exclude<OS, "unknown">;
  label: string;
  ext: string;
  href: string;
}

const BUTTONS: ButtonSpec[] = [
  {
    os: "mac",
    label: "Download for Mac",
    ext: ".dmg",
    href: "https://releases.inariwatch.com/latest/inari-live-mac.dmg",
  },
  {
    os: "windows",
    label: "Download for Windows",
    ext: ".msi",
    href: "https://releases.inariwatch.com/latest/inari-live-windows.msi",
  },
  {
    os: "linux",
    label: "Download for Linux",
    ext: ".AppImage",
    href: "https://releases.inariwatch.com/latest/inari-live-linux.AppImage",
  },
];

export function detectOS(userAgent: string): OS {
  const ua = userAgent.toLowerCase();
  if (ua.includes("mac")) return "mac";
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux") || ua.includes("x11")) return "linux";
  return "unknown";
}

export function DownloadButtons({
  variant = "row",
}: {
  variant?: "row" | "stack";
}) {
  const [os, setOS] = useState<OS>("unknown");

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    setOS(detectOS(navigator.userAgent));
  }, []);

  const layout =
    variant === "stack"
      ? "flex flex-col gap-3 sm:flex-row sm:flex-wrap"
      : "flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-3";

  return (
    <div data-testid="download-buttons" data-os={os} className={layout}>
      {BUTTONS.map((b) => {
        const isPrimary = os === b.os;
        return (
          <DownloadButton
            key={b.os}
            spec={b}
            isPrimary={isPrimary}
            disabled={!BINARIES_AVAILABLE}
          />
        );
      })}
    </div>
  );
}

function DownloadButton({
  spec,
  isPrimary,
  disabled,
}: {
  spec: ButtonSpec;
  isPrimary: boolean;
  disabled: boolean;
}) {
  const baseClass =
    "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-colors";
  const primaryClass = disabled
    ? "bg-inari-accent/40 text-white/70 cursor-not-allowed"
    : "bg-inari-accent text-white hover:bg-inari-accent/90";
  const secondaryClass = disabled
    ? "border border-inari-border bg-inari-card text-fg-muted cursor-not-allowed"
    : "border border-inari-border bg-inari-card text-fg-strong hover:border-inari-accent/40";

  const className = `${baseClass} ${
    isPrimary ? primaryClass : secondaryClass
  }`;

  const tag = disabled ? "Beta — coming this month" : `Download ${spec.ext}`;

  if (disabled) {
    return (
      <button
        type="button"
        disabled
        aria-disabled="true"
        data-testid={`download-${spec.os}`}
        data-primary={isPrimary ? "true" : "false"}
        className={className}
        title={tag}
      >
        <span>{spec.label}</span>
        <span className="rounded-full bg-black/20 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider">
          {spec.ext}
        </span>
      </button>
    );
  }

  return (
    <a
      href={spec.href}
      data-testid={`download-${spec.os}`}
      data-primary={isPrimary ? "true" : "false"}
      className={className}
    >
      <span>{spec.label}</span>
      <span className="rounded-full bg-black/20 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider">
        {spec.ext}
      </span>
    </a>
  );
}
