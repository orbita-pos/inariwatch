import localFont from "next/font/local";

/**
 * Satoshi — body/UI font. Self-hosted via next/font/local.
 * CSS var: --font-satoshi
 */
export const satoshi = localFont({
  src: [
    { path: "./fonts/satoshi-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/satoshi-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/satoshi-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-satoshi",
  display:  "swap",
  preload:  true,
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
});

/**
 * Clash Display — display/heading font. Self-hosted via next/font/local.
 * CSS var: --font-clash
 */
export const clashDisplay = localFont({
  src: [
    { path: "./fonts/clash-display-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/clash-display-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/clash-display-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-clash",
  display:  "swap",
  preload:  true,
  fallback: ["Satoshi", "ui-sans-serif", "system-ui", "sans-serif"],
});
