import type { MetadataRoute } from "next";

const BASE_URL = "https://inariwatch.com";

export default function robots(): MetadataRoute.Robots {
  const isPreview = process.env.VERCEL_ENV === "preview";

  if (isPreview) {
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
