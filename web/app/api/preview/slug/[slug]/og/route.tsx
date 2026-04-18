import { ImageResponse } from "next/og";
import { getPreviewBySlug } from "@/lib/services/preview/session.service";

export const runtime = "nodejs";

const SLUG_REGEX = /^[A-Z2-7]{12}$/;

/**
 * Preview Fix — Open Graph image.
 *
 *   GET /api/preview/slug/:slug/og  →  1200x630 PNG
 *
 * Referenced from the `/preview/[slug]` page's `generateMetadata`. Rendered
 * when someone pastes a preview URL into Slack / Discord / Twitter /
 * LinkedIn — turns the link from a plain text share into a compelling
 * visual card with the Verified badge + short slug.
 *
 * Content is cached 1h at the edge — receipts are content-addressed, but
 * preview metadata (status labels) can mutate as tiers finish. 1h is a
 * reasonable freshness window for social cards where the first impression
 * is what matters.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  if (!SLUG_REGEX.test(slug)) {
    return new Response("Invalid slug", { status: 400 });
  }

  const preview = await getPreviewBySlug(slug);
  if (!preview) return new Response("Not found", { status: 404 });

  const predictionReady = preview.predictionStatus === "ready";
  const liveReady = preview.liveStatus === "running";
  const verified = !!preview.eapReceiptId;
  const shortReceipt = preview.eapReceiptId
    ? `${preview.eapReceiptId.slice(0, 12)}…`
    : null;

  // When a hero screenshot has been captured, we render it as the full
  // background of the card with a dark scrim so the brand / receipt stay
  // legible. This is the "v0-quality" unfurl: on Twitter / Slack the user
  // sees the actual fix, not a gradient placeholder. Falls back to the
  // designed gradient card whenever the shot is missing or still capturing.
  //
  // next/og's ImageResponse needs an absolute URL — resolve against the
  // same origin we'd serve the proxy from.
  const origin =
    process.env.APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://app.inariwatch.com");
  const heroShot = preview.screenshotUrl
    ? `${origin}/api/preview/${preview.id}/screenshot.png`
    : null;

  if (heroShot) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            position: "relative",
            background: "#0A0A0A",
            color: "#fff",
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={heroShot}
            alt=""
            width={1200}
            height={630}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "top",
            }}
          />
          {/* dark scrim at bottom for text legibility */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              background:
                "linear-gradient(180deg, rgba(0,0,0,0.0) 40%, rgba(0,0,0,0.85) 100%)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 56,
              right: 56,
              bottom: 56,
              display: "flex",
              flexDirection: "column",
              gap: 18,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 20,
                letterSpacing: 2,
                textTransform: "uppercase",
                color: "rgba(255,255,255,0.72)",
              }}
            >
              <span style={{ fontFamily: "monospace", fontSize: 26, color: "#A78BFA", fontWeight: 700 }}>◉</span>
              <span style={{ fontWeight: 600, color: "rgba(255,255,255,0.95)" }}>InariWatch</span>
              <span>·</span>
              <span>Preview Fix</span>
            </div>
            <div
              style={{
                fontSize: 56,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                lineHeight: 1.05,
              }}
            >
              Autonomous fix preview
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontSize: 22,
                color: "rgba(255,255,255,0.82)",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              <span>/preview/{slug}</span>
              {verified && (
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 12px",
                    borderRadius: 999,
                    border: "1px solid rgba(16,185,129,0.55)",
                    background: "rgba(16,185,129,0.25)",
                    color: "#D1FAE5",
                    fontSize: 18,
                    fontWeight: 600,
                  }}
                >
                  🛡 EAP verified
                </span>
              )}
              {shortReceipt && (
                <span style={{ color: "rgba(255,255,255,0.55)" }}>receipt {shortReceipt}</span>
              )}
            </div>
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        headers: {
          "cache-control": "public, max-age=3600, s-maxage=3600",
        },
      },
    );
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background:
            "linear-gradient(135deg, #0A0A0A 0%, #0F0F14 50%, #14141C 100%)",
          color: "#fff",
          fontFamily: "system-ui, -apple-system, sans-serif",
          padding: "64px 72px",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* top-left eyebrow */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 20,
            letterSpacing: 2,
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.5)",
          }}
        >
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 28,
              color: "#7C3AED",
              fontWeight: 700,
            }}
          >
            ◉
          </span>
          <span style={{ fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>
            InariWatch
          </span>
          <span>·</span>
          <span>Preview Fix</span>
        </div>

        {/* main headline */}
        <div
          style={{
            marginTop: 48,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <div
            style={{
              fontSize: 72,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
              color: "#fff",
            }}
          >
            Autonomous fix preview
          </div>
          <div
            style={{
              fontSize: 28,
              color: "rgba(255,255,255,0.7)",
              lineHeight: 1.3,
              maxWidth: 940,
            }}
          >
            AI-predicted render + live sandbox deploy of a production fix,
            verifiable forever.
          </div>
        </div>

        {/* badges row */}
        <div
          style={{
            display: "flex",
            gap: 14,
            marginTop: "auto",
            alignItems: "center",
          }}
        >
          <Badge
            tone={predictionReady ? "green" : "amber"}
            label={predictionReady ? "AI prediction ready" : "AI predicting…"}
          />
          <Badge
            tone={liveReady ? "green" : "amber"}
            label={liveReady ? "Live sandbox up" : "Building sandbox…"}
          />
          {verified && <Badge tone="emerald" label="🛡 EAP verified" strong />}
        </div>

        {/* footer slug + receipt */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 40,
            paddingTop: 24,
            borderTop: "1px solid rgba(255,255,255,0.1)",
            fontSize: 22,
            color: "rgba(255,255,255,0.5)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          <span>/preview/{slug}</span>
          {shortReceipt && <span>receipt {shortReceipt}</span>}
        </div>

        {/* decorative glow */}
        <div
          style={{
            position: "absolute",
            top: "-25%",
            right: "-10%",
            width: 600,
            height: 600,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(124,58,237,0.35) 0%, rgba(124,58,237,0) 70%)",
            filter: "blur(40px)",
            pointerEvents: "none",
          }}
        />
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        "cache-control": "public, max-age=3600, s-maxage=3600",
      },
    },
  );
}

function Badge({
  tone,
  label,
  strong,
}: {
  tone: "green" | "amber" | "emerald";
  label: string;
  strong?: boolean;
}) {
  const palette = {
    green: { bg: "rgba(16,185,129,0.18)", border: "rgba(16,185,129,0.4)", text: "#A7F3D0" },
    emerald: { bg: "rgba(16,185,129,0.25)", border: "rgba(16,185,129,0.55)", text: "#D1FAE5" },
    amber: { bg: "rgba(245,158,11,0.15)", border: "rgba(245,158,11,0.4)", text: "#FDE68A" },
  }[tone];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "12px 18px",
        borderRadius: 999,
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        color: palette.text,
        fontSize: 22,
        fontWeight: strong ? 600 : 500,
      }}
    >
      {label}
    </div>
  );
}
