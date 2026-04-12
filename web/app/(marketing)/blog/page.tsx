import Link from "next/link";
import Image from "next/image";
import { ArrowRight } from "lucide-react";
import { db, blogPosts } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import { MarketingNav } from "../marketing-nav";
import { SubscribeForm } from "./subscribe-form";
import type { Metadata } from "next";

const PAGE_TITLE       = "Blog — InariWatch";
const PAGE_DESCRIPTION = "Engineering updates, feature announcements, and DevOps insights from the InariWatch team.";
const PAGE_URL         = "https://inariwatch.com/blog";

export const metadata: Metadata = {
  title:       PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates:  { canonical: PAGE_URL },
  openGraph: {
    type:        "website",
    url:         PAGE_URL,
    siteName:    "InariWatch",
    title:       PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    images:      [{ url: "/image-blog.png", width: 1200, height: 630, alt: "InariWatch blog" }],
  },
  twitter: {
    card:        "summary_large_image",
    site:        "@inariwatch",
    title:       PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    images:      ["/image-blog.png"],
  },
};

function formatDate(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default async function BlogPage() {
  const posts = await db
    .select()
    .from(blogPosts)
    .where(eq(blogPosts.isPublished, true))
    .orderBy(desc(blogPosts.publishedAt));

  const jsonLd = {
    "@context":   "https://schema.org",
    "@type":      "Blog",
    "@id":        `${PAGE_URL}/#blog`,
    name:         "InariWatch Blog",
    description:  PAGE_DESCRIPTION,
    url:          PAGE_URL,
    publisher: {
      "@type": "Organization",
      name:    "InariWatch",
      logo: {
        "@type": "ImageObject",
        url:     "https://inariwatch.com/logo-inari/favicon-96x96.png",
      },
    },
    blogPost: posts.map((p) => ({
      "@type":        "BlogPosting",
      headline:       p.title,
      description:    p.description,
      url:            `${PAGE_URL}/${p.slug}`,
      datePublished:  p.publishedAt?.toISOString(),
      dateModified:   p.updatedAt?.toISOString(),
      author:         { "@type": "Person", name: "Jesus Bernal" },
    })),
  };

  return (
    <div className="min-h-screen bg-inari-bg">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <MarketingNav opaque />
      <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
        <div className="mb-14">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">Blog</p>
          <h1 className="text-4xl font-bold text-fg-strong tracking-tight">What we&apos;re building</h1>
          <p className="mt-3 text-fg-base">Feature releases, engineering deep-dives, and DevOps insights.</p>
        </div>

        {/* Subscribe inline */}
        <section
          aria-labelledby="subscribe-heading"
          className="mb-10 rounded-xl border border-inari-border bg-inari-card/50 px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-4"
        >
          <div className="flex-1 min-w-0">
            <p id="subscribe-heading" className="text-sm font-medium text-fg-strong">Get notified on new posts</p>
            <p className="text-xs text-fg-base mt-0.5">No spam — just feature releases and engineering updates.</p>
          </div>
          <div className="w-full sm:w-72 shrink-0">
            <SubscribeForm compact />
          </div>
        </section>

        {posts.length === 0 ? (
          <p className="text-fg-base">No posts yet — check back soon.</p>
        ) : (
          <section aria-labelledby="posts-heading" className="space-y-4">
            <h2 id="posts-heading" className="sr-only">All posts</h2>
            {posts.map((post) => (
              <Link
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="group block rounded-xl border border-inari-border bg-inari-card p-6 hover:border-inari-accent/40 hover:bg-surface-inner transition-colors"
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-inari-accent/10 text-inari-accent border border-inari-accent/20">
                    {post.tag}
                  </span>
                  <span className="text-xs text-fg-base/70">{formatDate(post.publishedAt)}</span>
                </div>
                <h3 className="text-lg font-semibold text-fg-strong group-hover:text-inari-accent transition-colors leading-snug">
                  {post.title}
                </h3>
                <p className="mt-2 text-sm text-fg-base leading-relaxed">{post.description}</p>
                <div className="mt-4 flex items-center gap-1 text-xs text-inari-accent opacity-0 group-hover:opacity-100 transition-opacity">
                  Read more <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </div>
              </Link>
            ))}
          </section>
        )}
      </main>

      {/* Footer — matches landing page */}
      <footer className="border-t border-inari-border py-12">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <Image
                src="/logo-inari/favicon-96x96.png"
                alt=""
                width={24}
                height={24}
              />
              <span className="font-mono text-sm text-fg-base">
                inariwatch · built in MX
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-fg-base">
              <Link href="/docs"    className="hover:text-fg-strong transition-colors">Docs</Link>
              <Link href="/pricing" className="hover:text-fg-strong transition-colors">Pricing</Link>
              <Link href="/download" className="hover:text-fg-strong transition-colors">Mobile</Link>
              <Link href="/trust"   className="hover:text-fg-strong transition-colors">Trust</Link>
              <Link href="/status"  className="hover:text-fg-strong transition-colors">Status</Link>
              <Link href="/blog"    className="hover:text-fg-strong transition-colors">Blog</Link>
              <a
                href="https://github.com/orbita-pos/inariwatch-capture"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-fg-strong transition-colors"
              >
                GitHub
              </a>
              <Link href="/privacy" className="hover:text-fg-strong transition-colors">Privacy</Link>
              <Link href="/terms"   className="hover:text-fg-strong transition-colors">Terms</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
