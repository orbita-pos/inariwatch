import { defineConfig } from "vite"
import { inariwatchVite } from "@inariwatch/capture/vite"

export default defineConfig({
  plugins: [inariwatchVite()],
  build: {
    ssr: true,
    rollupOptions: {
      output: { format: "esm" },
    },
  },
})
