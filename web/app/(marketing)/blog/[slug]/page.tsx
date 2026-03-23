import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { db, blogPosts } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { MarketingNav } from "../../marketing-nav";
import type { Metadata } from "next";

function formatDate(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
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
      return safe ? `<a href="${url}">${text}</a>` : text;
    })
    .replace(/^---$/gm, "<hr>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>")
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
    .select({ title: blogPosts.title, description: blogPosts.description })
    .from(blogPosts)
    .where(and(eq(blogPosts.slug, slug), eq(blogPosts.isPublished, true)))
    .limit(1);
  if (!post) return {};
  return {
    title: `${post.title} — InariWatch Blog`,
    description: post.description,
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

  return (
    <div className="min-h-screen bg-inari-bg">
      <MarketingNav />
      <main className="mx-auto max-w-2xl px-6 pt-32 pb-24">
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors mb-10"
        >
          <ArrowLeft className="h-4 w-4" />
          All posts
        </Link>

        <div className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-inari-accent/10 text-inari-accent border border-inari-accent/20">
              {post.tag}
            </span>
            <span className="text-xs text-zinc-600">{formatDate(post.publishedAt)}</span>
          </div>
          <h1 className="text-3xl font-bold text-fg-strong leading-tight sm:text-4xl">{post.title}</h1>
          <p className="mt-4 text-fg-base leading-relaxed">{post.description}</p>
        </div>

        <hr className="border-inari-border mb-10" />

        <article
          className="prose prose-invert prose-zinc max-w-none
            prose-headings:font-bold prose-headings:text-fg-strong prose-headings:tracking-tight
            prose-h2:text-2xl prose-h2:mt-10 prose-h2:mb-4
            prose-h3:text-lg prose-h3:mt-8 prose-h3:mb-3
            prose-p:text-fg-base prose-p:leading-relaxed prose-p:my-4
            prose-a:text-inari-accent prose-a:no-underline hover:prose-a:underline
            prose-strong:text-fg-strong
            prose-code:text-inari-accent prose-code:bg-inari-accent/10 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono prose-code:before:content-none prose-code:after:content-none
            prose-pre:bg-zinc-950 prose-pre:border prose-pre:border-inari-border prose-pre:rounded-xl
            prose-blockquote:border-inari-accent prose-blockquote:text-zinc-400
            prose-ul:text-fg-base prose-li:my-1
            prose-hr:border-inari-border"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(post.content) }}
        />

        <div className="mt-16 rounded-xl border border-inari-accent/25 bg-inari-accent-dim p-6 text-center">
          <p className="text-sm font-semibold text-fg-strong mb-1">Try InariWatch for free</p>
          <p className="text-xs text-zinc-500 mb-4">No credit card required. Connect your stack in minutes.</p>
          <Link
            href="/register"
            className="inline-flex items-center gap-2 rounded-lg bg-inari-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-inari-accent/90 transition-colors"
          >
            Get started free
          </Link>
        </div>
      </main>
    </div>
  );
}
