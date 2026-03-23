import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        inari: {
          accent:     "#7C3AED",
          "accent-dim": "rgba(124,58,237,0.06)",
          bg:         "var(--inari-bg)",
          card:       "var(--inari-card)",
          border:     "var(--inari-border)",
          muted:      "#52525b",
        },
        // ── Semantic theme tokens (respond to light/dark CSS vars) ───────────
        page:           "var(--bg-page)",
        surface:        "var(--bg-card)",
        "surface-inner":"var(--bg-card-inner)",
        "surface-dim":  "var(--bg-card-elevated)",
        line:           "var(--bd-default)",
        "line-subtle":  "var(--bd-subtle)",
        "line-medium":  "var(--bd-medium)",
        "fg-strong":    "var(--fg-strong)",
        "fg-base":      "var(--fg-base)",
      },
      fontFamily: {
        mono: ["'Geist Mono'", "ui-monospace", "monospace"],
        sans: ["'Geist'", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      animation: {
        "blink": "blink 1s step-end infinite",
        "fade-up": "fade-up 0.5s ease-out both",
      },
      keyframes: {
        blink: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0" } },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};

export default config;
