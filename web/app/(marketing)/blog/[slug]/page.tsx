import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft } from "lucide-react";
import { headers } from "next/headers";
import blogHero from "@/public/image-blog.png";
import { db, blogPosts } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { MarketingNav } from "../../marketing-nav";
import { SubscribeForm } from "../subscribe-form";
import type { Metadata } from "next";

function formatDate(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function readingTime(content: string): number {
  const words = content.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}

// Simple markdown → HTML (no external dep)
function renderMarkdown(md: string): string {
  return md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/```[\w]*\n([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[(.+?)\]\((.+?)\)/g, (_, text, url) => {
      const safe = url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/");
      if (!safe) return text;
      const href = url.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      return `<a href="${href}">${text}</a>`;
    })
    .replace(/^---$/gm, "<hr>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>")
    .split(/\n\n+/)
    .map((block) => {
      if (/^<(h[1-6]|ul|pre|hr)/.test(block.trim())) return block;
      return `<p>${block.replace(/\n/g, " ")}</p>`;
    })
    .join("\n");
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const [post] = await db
    .select({
      title:       blogPosts.title,
      description: blogPosts.description,
      publishedAt: blogPosts.publishedAt,
      tag:         blogPosts.tag,
    })
    .from(blogPosts)
    .where(and(eq(blogPosts.slug, slug), eq(blogPosts.isPublished, true)))
    .limit(1);
  if (!post) return {};

  const url = `https://inariwatch.com/blog/${slug}`;

  return {
    title:       `${post.title} — InariWatch Blog`,
    description: post.description,
    alternates:  { canonical: url },
    openGraph: {
      type:        "article",
      url,
      siteName:    "InariWatch",
      title:       post.title,
      description: post.description,
      images:      [{ url: "/image-blog.png", width: 1200, height: 630, alt: post.title }],
      ...(post.publishedAt && { publishedTime: post.publishedAt.toISOString() }),
    },
    twitter: {
      card:        "summary_large_image",
      site:        "@inariwatch",
      title:       post.title,
      description: post.description,
      images:      ["/image-blog.png"],
    },
  };
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [post] = await db
    .select()
    .from(blogPosts)
    .where(and(eq(blogPosts.slug, slug), eq(blogPosts.isPublished, true)))
    .limit(1);

  if (!post) notFound();

  const mins = readingTime(post.content);

  const jsonLd = {
    "@context":    "https://schema.org",
    "@type":       "BlogPosting",
    headline:      post.title,
    description:   post.description,
    datePublished: post.publishedAt?.toISOString(),
    dateModified:  post.updatedAt?.toISOString(),
    author:        { "@type": "Person", name: "Jesus Bernal", url: "https://jesusbr.com" },
    publisher: {
      "@type": "Organization",
      name:    "InariWatch",
      logo:    { "@type": "ImageObject", url: "https://inariwatch.com/logo-inari/favicon-96x96.png" },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": `https://inariwatch.com/blog/${slug}` },
    image:        "https://inariwatch.com/image-blog.png",
    wordCount:    post.content.trim().split(/\s+/).length,
  };

  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <div className="min-h-screen bg-inari-bg">
      <script nonce={nonce} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <MarketingNav opaque />
      <main className="mx-auto max-w-2xl px-6 pt-24 pb-24">

        {/* Back */}
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 text-sm text-fg-base hover:text-fg-strong transition-colors mb-8"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          All posts
        </Link>

        {/* Hero card — image + title overlay on left negative space */}
        <div className="relative mb-8 overflow-hidden rounded-2xl border border-inari-border bg-[#0c0c12]">
          <Image
            src={blogHero}
            alt=""
            className="w-full object-cover"
            priority
            placeholder="blur"
          />
          {/* Gradient to ensure text readability over the left dark area */}
          <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/40 to-transparent" aria-hidden="true" />

          {/* Text overlay — left side */}
          <div className="absolute inset-0 flex flex-col justify-center px-7 sm:px-10 max-w-[58%]">
            <span className="mb-3 inline-flex w-fit items-center rounded-full border border-inari-accent/30 bg-inari-accent/20 px-3 py-1 text-xs font-mono font-medium text-inari-accent backdrop-blur-sm">
              {post.tag}
            </span>
            <h1 className="text-xl font-bold leading-snug text-white sm:text-2xl">
              {post.title}
            </h1>
            <p className="mt-2 text-xs leading-relaxed text-white/70 line-clamp-2 hidden sm:block">
              {post.description}
            </p>
          </div>
        </div>

        {/* Meta */}
        <div className="mb-10 flex items-center gap-2 text-xs text-fg-base">
          <span>{formatDate(post.publishedAt)}</span>
          <span className="text-fg-base/40" aria-hidden="true">·</span>
          <span>{mins} min read</span>
        </div>

        {/* Content */}
        <article
          className="prose dark:prose-invert max-w-none
            prose-headings:font-bold prose-headings:text-fg-strong prose-headings:tracking-tight
            prose-h2:text-2xl prose-h2:mt-10 prose-h2:mb-4
            prose-h3:text-lg prose-h3:mt-8 prose-h3:mb-3
            prose-p:text-fg-base prose-p:leading-relaxed prose-p:my-4
            prose-a:text-inari-accent prose-a:no-underline hover:prose-a:underline
            prose-strong:text-fg-strong
            prose-code:text-inari-accent prose-code:bg-inari-accent/10 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono prose-code:before:content-none prose-code:after:content-none
            prose-pre:bg-surface-inner prose-pre:border prose-pre:border-inari-border prose-pre:rounded-xl
            prose-blockquote:border-inari-accent prose-blockquote:text-fg-base
            prose-ul:text-fg-base prose-li:my-1
            prose-hr:border-inari-border"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(post.content) }}
        />

        {/* Subscribe */}
        <section aria-labelledby="post-subscribe-heading" className="mt-12 rounded-xl border border-inari-border bg-inari-card/50 px-5 py-5">
          <p id="post-subscribe-heading" className="text-sm font-medium text-fg-strong mb-0.5">Enjoyed this post?</p>
          <p className="text-xs text-fg-base mb-4">Get notified when we publish new ones — no spam, unsubscribe any time.</p>
          <SubscribeForm compact />
        </section>

        <div className="mt-4 rounded-xl border border-inari-accent/25 bg-inari-accent-dim p-6 text-center">
          <p className="text-sm font-semibold text-fg-strong mb-1">Try InariWatch for free</p>
          <p className="text-xs text-fg-base mb-4">No credit card required. Connect your stack in minutes.</p>
          <Link
            href="/register"
            className="inline-flex items-center gap-2 rounded-lg bg-inari-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-inari-accent/90 transition-colors"
          >
            Get started free
          </Link>
        </div>
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
