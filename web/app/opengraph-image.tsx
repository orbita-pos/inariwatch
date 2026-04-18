import { ImageResponse } from "next/og";

export const runtime     = "nodejs";
export const alt         = "InariWatch — Monitoring that ships the fix. Verifiably.";
export const size        = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width:           "100%",
          height:          "100%",
          display:         "flex",
          flexDirection:   "column",
          justifyContent:  "space-between",
          padding:         "80px",
          background:      "#0a0a0c",
          backgroundImage:
            "radial-gradient(ellipse 900px 500px at 30% 10%, rgba(234,88,12,0.22), transparent 65%), radial-gradient(ellipse 800px 500px at 85% 90%, rgba(234,88,12,0.1), transparent 65%)",
          color:           "#f5f5f7",
          fontFamily:      "sans-serif",
        }}
      >
        {/* Top row — brand + status pill */}
        <div
          style={{
            display:        "flex",
            alignItems:     "center",
            justifyContent: "space-between",
            width:          "100%",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <div
              style={{
                width:           44,
                height:          44,
                borderRadius:    12,
                background:      "#ea580c",
                display:         "flex",
                alignItems:      "center",
                justifyContent:  "center",
                fontSize:        26,
                fontWeight:      700,
                color:           "#0a0a0c",
              }}
            >
              I
            </div>
            <div
              style={{
                fontSize:       26,
                fontWeight:     600,
                letterSpacing:  "-0.01em",
              }}
            >
              InariWatch
            </div>
          </div>

          <div
            style={{
              display:        "flex",
              alignItems:     "center",
              gap:            10,
              padding:        "8px 18px",
              border:         "1px solid rgba(234,88,12,0.35)",
              borderRadius:   999,
              fontSize:       16,
              fontFamily:     "monospace",
              color:          "#fb923c",
              background:     "rgba(234,88,12,0.08)",
            }}
          >
            <div
              style={{
                width:        10,
                height:       10,
                borderRadius: 999,
                background:   "#ea580c",
              }}
            />
            now in beta — free full access
          </div>
        </div>

        {/* Center — headline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              fontSize:       96,
              fontWeight:     700,
              letterSpacing:  "-0.04em",
              lineHeight:     0.95,
              color:          "#ffffff",
            }}
          >
            Monitoring that
          </div>
          <div
            style={{
              fontSize:       96,
              fontWeight:     700,
              letterSpacing:  "-0.04em",
              lineHeight:     0.95,
              background:     "linear-gradient(135deg, #fb923c 0%, #ea580c 55%, #c2410c 100%)",
              backgroundClip: "text",
              color:          "transparent",
            }}
          >
            ships the fix.
          </div>
          <div
            style={{
              fontSize:   28,
              lineHeight: 1.4,
              color:      "rgba(245,245,247,0.7)",
              maxWidth:   900,
              marginTop:  10,
            }}
          >
            17 safety gates. Cryptographic proof chain. Live preview of every autonomous fix.
          </div>
        </div>

        {/* Bottom row — integrations */}
        <div
          style={{
            display:        "flex",
            alignItems:     "center",
            justifyContent: "space-between",
            width:          "100%",
            fontSize:       18,
            color:          "rgba(245,245,247,0.5)",
            fontFamily:     "monospace",
          }}
        >
          <div>GitHub · Vercel · Sentry · Datadog · Expo · Capture SDK</div>
          <div style={{ color: "#ea580c" }}>inariwatch.com</div>
        </div>
      </div>
    ),
    { ...size }
  );
}
