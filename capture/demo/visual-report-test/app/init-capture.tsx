"use client";

import { useEffect } from "react";

/**
 * Boot @inariwatch/capture with the visual-report integration.
 *
 * Config comes from the standard NEXT_PUBLIC_INARIWATCH_* env vars so
 * the demo behaves identically to a real customer's Next.js app. Drop
 * these into `.env.local` (see .env.example):
 *
 *   NEXT_PUBLIC_INARIWATCH_TOKEN=iwk_pub_v1_…
 *   NEXT_PUBLIC_INARIWATCH_PROJECT_ID=<uuid>
 *   NEXT_PUBLIC_INARIWATCH_HOST=http://localhost:3000
 */
export function InitCapture() {
  useEffect(() => {
    void (async () => {
      try {
        const { init } = await import("@inariwatch/capture");
        const { visualReportIntegration } = await import("@inariwatch/capture/visual-report");

        const token     = process.env.NEXT_PUBLIC_INARIWATCH_TOKEN;
        const projectId = process.env.NEXT_PUBLIC_INARIWATCH_PROJECT_ID;
        const host      = process.env.NEXT_PUBLIC_INARIWATCH_HOST ?? "http://localhost:3000";

        if (!token || !projectId) {
          console.warn(
            "[demo] Missing NEXT_PUBLIC_INARIWATCH_TOKEN or NEXT_PUBLIC_INARIWATCH_PROJECT_ID — " +
            "the widget will mount but submit will be a no-op. Add both to .env.local.",
          );
        }

        init({
          token,
          projectId,
          host,
          environment: "development",
          debug: true,
          integrations: [
            visualReportIntegration({
              position:    "bottom-right",
              buttonLabel: "Report visual bug",
              title:       "Report a visual bug",
              accentColor: "#D8A66E",       // Inari warm amber
              onUploaded: (result) => {
                if (result.ok) {
                  console.log("[demo] ✓ Report uploaded:", result.reportId);
                  console.log("[demo]   Alert:", result.alertId);
                  console.log("[demo]   Open Inari Live and press Cmd+\\ on the new alert.");
                } else {
                  console.error("[demo] ✗ Upload failed:", result.status, result.error);
                }
              },
            }),
          ],
        });

        console.log("[demo] Inari capture initialised with visual-report integration");
      } catch (err) {
        console.error("[demo] capture init failed:", err);
      }
    })();
  }, []);

  return null;
}
