import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // Point @inariwatch/capture at the local workspace dist so payload v2
      // SDK changes are tested before publish. Runtime (Next) still resolves
      // the published npm version.
      "@inariwatch/capture": path.resolve(__dirname, "../capture/dist/index.js"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    exclude: ["__tests__/**/*.spec.ts", "node_modules/**"],
  },
});
