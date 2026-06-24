import type { NextConfig } from "next"
import { withInariWatch } from "@inariwatch/capture/next"

// Standard config the docs tell users to write. We wrap it with
// @inariwatch/capture/next to exercise the same code path a real user
// hits. If the wrap pulls heavy modules into the build, this will show
// up in the analyzer output.
const nextConfig: NextConfig = {
  reactStrictMode: true,
}

export default withInariWatch(nextConfig)
