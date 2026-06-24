import type { MetadataRoute } from "next";

const BASE_URL = "https://inariwatch.com";

export default function robots(): MetadataRoute.Robots {
  // Hide from search engines on preview / staging hosts. Set DISABLE_INDEXING=1
  // on any non-production deployment. Legacy fallback to VERCEL_ENV==="preview"
  // keeps behavior identical while Vercel remains the primary host.
  const disableIndexing =
    process.env.DISABLE_INDEXING === "1" ||
    process.env.VERCEL_ENV === "preview";

  if (disableIndexing) {
    return {
      rules: [{ userAgent: "*", disallow: "/" }],
    };
  }

  return {
    rules: [
      {
        userAgent: "*",
        allow:     "/",
        disallow: [
          "/api/",
          "/dashboard/",
          "/alerts/",
          "/integrations/",
          "/projects/",
          "/settings/",
          "/chat/",
          "/admin/",
          "/onboarding/",
          "/recordings/",
          "/workspace/",
        ],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
    host:    BASE_URL,
  };
}
