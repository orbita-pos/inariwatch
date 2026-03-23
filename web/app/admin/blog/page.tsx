import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, blogPosts } from "@/lib/db";
import { desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Plus, Pencil, Globe, FileText } from "lucide-react";
import { DeletePostButton } from "./delete-button";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Blog Admin — InariWatch" };

function requireAdmin(email: string | null | undefined): boolean {
  const adminEmail = process.env.ADMIN_EMAIL;
  return !!adminEmail && email === adminEmail;
}

export default async function AdminBlogPage() {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string })?.email;
  if (!requireAdmin(email)) notFound();

  const posts = await db
    .select()
    .from(blogPosts)
    .orderBy(desc(blogPosts.createdAt));

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <div className="flex items-center justify-between mb-10">
          <div>
            <p className="text-xs font-mono text-violet-400 uppercase tracking-widest mb-1">Admin</p>
            <h1 className="text-2xl font-bold">Blog</h1>
          </div>
          <Link
            href="/admin/blog/new"
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New post
          </Link>
        </div>

        {posts.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-10 text-center">
            <p className="text-zinc-500">No posts yet.</p>
            <Link
              href="/admin/blog/new"
              className="mt-4 inline-flex items-center gap-2 text-sm text-violet-400 hover:text-violet-300"
            >
              <Plus className="h-4 w-4" /> Write your first post
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {posts.map((post) => (
              <div
                key={post.id}
                className="flex items-center justify-between gap-4 rounded-xl border border-zinc-800 bg-zinc-900/50 px-5 py-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    {post.isPublished ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                        <Globe className="h-3 w-3" /> Published
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
                        <FileText className="h-3 w-3" /> Draft
                      </span>
                    )}
                    <span className="text-xs text-zinc-700">·</span>
                    <span className="text-xs font-mono text-zinc-600 px-1.5 py-0.5 rounded bg-zinc-800">
                      {post.tag}
                    </span>
                  </div>
                  <p className="text-sm font-semibold text-white truncate">{post.title}</p>
                  <p className="text-xs text-zinc-600 truncate mt-0.5">/blog/{post.slug}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {post.isPublished && (
                    <Link
                      href={`/blog/${post.slug}`}
                      target="_blank"
                      className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      View
                    </Link>
                  )}
                  <Link
                    href={`/admin/blog/${post.id}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    <Pencil className="h-3 w-3" />
                    Edit
                  </Link>
                  <DeletePostButton id={post.id} title={post.title} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
