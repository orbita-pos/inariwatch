const path = require("path")
const { withInariWatchWebpack } = require("@inariwatch/capture/webpack")

module.exports = withInariWatchWebpack({
  mode: "production",
  target: "node",
  entry: "./src/entry.js",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "out.cjs",
    library: { type: "commonjs2" },
  },
  experiments: { topLevelAwait: true },
})
