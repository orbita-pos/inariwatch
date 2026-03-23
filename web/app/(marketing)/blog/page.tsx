import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { db, blogPosts } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import { MarketingNav } from "../marketing-nav";
import { SubscribeForm } from "./subscribe-form";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Blog — InariWatch",
  description: "Engineering updates, feature announcements, and DevOps insights from the InariWatch team.",
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

  return (
    <div className="min-h-screen bg-inari-bg">
      <MarketingNav opaque />
      <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
        <div className="mb-14">
          <p className="text-xs font-mono text-inari-accent uppercase tracking-widest mb-3">Blog</p>
          <h1 className="text-4xl font-bold text-fg-strong tracking-tight">What we're building</h1>
          <p className="mt-3 text-fg-base">Feature releases, engineering deep-dives, and DevOps insights.</p>
        </div>

        {/* Subscribe inline */}
        <div className="mb-10 rounded-xl border border-inari-border bg-inari-card/50 px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-fg-strong">Get notified on new posts</p>
            <p className="text-xs text-zinc-500 mt-0.5">No spam — just feature releases and engineering updates.</p>
          </div>
          <div className="w-full sm:w-72 shrink-0">
            <SubscribeForm compact />
          </div>
        </div>

        {posts.length === 0 ? (
          <p className="text-zinc-500">No posts yet — check back soon.</p>
        ) : (
          <div className="space-y-4">
            {posts.map((post) => (
              <Link
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="group block rounded-xl border border-inari-border bg-inari-card p-6 hover:border-inari-accent/40 hover:bg-inari-accent-dim transition-all"
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-inari-accent/10 text-inari-accent border border-inari-accent/20">
                    {post.tag}
                  </span>
                  <span className="text-xs text-zinc-600">{formatDate(post.publishedAt)}</span>
                </div>
                <h2 className="text-lg font-semibold text-fg-strong group-hover:text-white transition-colors leading-snug">
                  {post.title}
                </h2>
                <p className="mt-2 text-sm text-zinc-500 leading-relaxed">{post.description}</p>
                <div className="mt-4 flex items-center gap-1 text-xs text-inari-accent opacity-0 group-hover:opacity-100 transition-opacity">
                  Read more <ArrowRight className="h-3 w-3" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
