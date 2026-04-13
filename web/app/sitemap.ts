import { MetadataRoute } from "next";
import { db, blogPosts } from "@/lib/db";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const BASE_URL = "https://inariwatch.com";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE_URL, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE_URL}/pricing`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${BASE_URL}/docs`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE_URL}/blog`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE_URL}/trust`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${BASE_URL}/network`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${BASE_URL}/download`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${BASE_URL}/status`, changeFrequency: "always", priority: 0.5 },
    { url: `${BASE_URL}/register`, changeFrequency: "never", priority: 0.5 },
    { url: `${BASE_URL}/login`, changeFrequency: "never", priority: 0.3 },
    { url: `${BASE_URL}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE_URL}/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];

  const posts = await db
    .select({ slug: blogPosts.slug, updatedAt: blogPosts.updatedAt })
    .from(blogPosts)
    .where(eq(blogPosts.isPublished, true));

  const blogPages: MetadataRoute.Sitemap = posts.map((p) => ({
    url: `${BASE_URL}/blog/${p.slug}`,
    lastModified: p.updatedAt,
    changeFrequency: "monthly" as const,
    priority: 0.6,
  }));

  return [...staticPages, ...blogPages];
}
