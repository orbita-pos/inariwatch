import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Vite multi-page config for Inari Live.
//
// Three HTML entries live at the project root (`desktop/`):
//   - dock.html  → mounted by `inari-live-dock` Tauri window
//   - main.html  → mounted by the main React shell window
//   - dev.html   → /dev/components Storybook page (manual smoke only)
//
// Output goes to `desktop/dist/` so the existing visual-prototype
// assets (`dist/inari/`, `dist/sdk-bundle/`, `dist/inari-live-dock/`)
// stay alongside without churn. `emptyOutDir: false` preserves them
// across rebuilds so the legacy `inari` window keeps booting until
// Session 17 retires it.
//
// `clearScreen: false` keeps Tauri's debug output visible during
// `pnpm tauri dev`. The `@` alias maps to `desktop/src/` to match the
// path imports the components use.

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: {
        dock: path.resolve(__dirname, "dock.html"),
        main: path.resolve(__dirname, "main.html"),
        dev: path.resolve(__dirname, "dev.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  clearScreen: false,
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/tests/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
