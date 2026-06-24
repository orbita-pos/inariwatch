import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Don't strip source maps in dev. When the test app eventually points at
  // the cloud, the build plugin (V0.5) injects __INARI_BUILD_ID__ and
  // uploads maps for server-side resolution.
};

export default nextConfig;
