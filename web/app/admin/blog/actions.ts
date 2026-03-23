"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, blogPosts } from "@/lib/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

async function requireAdmin(): Promise<{ error: string } | null> {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string })?.email;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return { error: "ADMIN_EMAIL not configured." };
  if (!email || email !== adminEmail) return { error: "Not authorized." };
  return null;
}

export async function createPost(data: {
  title: string;
  description: string;
  content: string;
  tag: string;
  publish: boolean;
}): Promise<{ error?: string; id?: string }> {
  const denied = await requireAdmin();
  if (denied) return { error: denied.error };

  const { title, description, content, tag, publish } = data;
  if (!title.trim()) return { error: "Title is required." };
  if (!content.trim()) return { error: "Content is required." };

  let slug = slugify(title);
  if (!slug) return { error: "Could not generate slug from title." };

  // Ensure slug uniqueness
  const existing = await db.select({ id: blogPosts.id }).from(blogPosts).where(eq(blogPosts.slug, slug)).limit(1);
  if (existing.length > 0) slug = `${slug}-${Date.now().toString(36)}`;

  const [post] = await db.insert(blogPosts).values({
    slug,
    title: title.trim(),
    description: description.trim(),
    content: content.trim(),
    tag: tag.trim() || "Update",
    isPublished: publish,
    publishedAt: publish ? new Date() : null,
  }).returning({ id: blogPosts.id });

  revalidatePath("/blog");
  revalidatePath("/admin/blog");
  return { id: post.id };
}

export async function updatePost(
  id: string,
  data: {
    title: string;
    description: string;
    content: string;
    tag: string;
    publish: boolean;
  }
): Promise<{ error?: string }> {
  const denied = await requireAdmin();
  if (denied) return { error: denied.error };

  const { title, description, content, tag, publish } = data;
  if (!title.trim()) return { error: "Title is required." };

  const [existing] = await db.select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1);
  if (!existing) return { error: "Post not found." };

  // If newly publishing, set publishedAt
  const publishedAt = publish && !existing.isPublished ? new Date() : existing.publishedAt;

  await db.update(blogPosts).set({
    title: title.trim(),
    description: description.trim(),
    content: content.trim(),
    tag: tag.trim() || "Update",
    isPublished: publish,
    publishedAt,
    updatedAt: new Date(),
  }).where(eq(blogPosts.id, id));

  revalidatePath("/blog");
  revalidatePath(`/blog/${existing.slug}`);
  revalidatePath("/admin/blog");
  return {};
}

export async function deletePost(id: string): Promise<{ error?: string }> {
  const denied = await requireAdmin();
  if (denied) return { error: denied.error };

  const [post] = await db.select({ slug: blogPosts.slug }).from(blogPosts).where(eq(blogPosts.id, id)).limit(1);
  if (!post) return { error: "Post not found." };

  await db.delete(blogPosts).where(eq(blogPosts.id, id));

  revalidatePath("/blog");
  revalidatePath(`/blog/${post.slug}`);
  revalidatePath("/admin/blog");
  return {};
}
