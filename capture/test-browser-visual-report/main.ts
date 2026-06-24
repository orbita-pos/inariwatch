/**
 * Visual Report e2e test page boot. Reads the project token + projectId
 * from `window.__IW_TEST_CONFIG__` (injected by the Playwright script
 * via `addInitScript` before this module executes).
 *
 * If the config object is missing we still boot the integration so the
 * widget renders — submit will surface a clear "no token" warning to
 * the test runner. That makes failures localized rather than the page
 * silently doing nothing.
 */

import { init } from "../src/index"
import { visualReportIntegration } from "../src/visual-report/index"

declare global {
  interface Window {
    __IW_TEST_CONFIG__?: {
      token:     string;
      projectId: string;
      host:      string;
    };
    __IW_TEST_RESULT__?: {
      uploadResult?: unknown;
      error?:        string;
    };
  }
}

const cfg = window.__IW_TEST_CONFIG__;

if (!cfg) {
  console.warn("[e2e] No __IW_TEST_CONFIG__ — widget will mount but submit will fail.");
}

init({
  token:       cfg?.token,
  projectId:   cfg?.projectId,
  host:        cfg?.host ?? "http://localhost:3000",
  environment: "test",
  debug:       true,
  integrations: [
    visualReportIntegration({
      position:    "bottom-right",
      buttonLabel: "Report visual bug",
      title:       "Report a visual bug",
      onUploaded: (result) => {
        // Surface the result to the Playwright runner so it can assert
        // without polling the DB.
        window.__IW_TEST_RESULT__ = { uploadResult: result };
        console.log("[e2e] upload result:", JSON.stringify(result));
      },
    }),
  ],
});

console.log("[e2e] capture initialised with visual-report");
