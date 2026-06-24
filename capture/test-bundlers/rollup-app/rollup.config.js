import { nodeResolve } from "@rollup/plugin-node-resolve"
import commonjs from "@rollup/plugin-commonjs"

export default {
  input: "src/entry.js",
  output: {
    file: "dist/out.mjs",
    format: "esm",
    inlineDynamicImports: true,
  },
  plugins: [nodeResolve({ preferBuiltins: true }), commonjs()],
  external: [/^node:/],
}
