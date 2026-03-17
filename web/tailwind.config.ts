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
          bg:         "#09090b",
          card:       "#0d0d10",
          border:     "#1e1e22",
          muted:      "#52525b",
        },
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
  plugins: [],
};

export default config;
