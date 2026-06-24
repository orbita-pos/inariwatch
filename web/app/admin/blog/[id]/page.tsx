import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, blogPosts } from "@/lib/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { PostEditor } from "../post-editor";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Edit post — Blog Admin" };

export default async function EditPostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string })?.email;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail || email !== adminEmail) notFound();

  const { id } = await params;
  const [post] = await db.select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1);
  if (!post) notFound();

  return (
    <PostEditor
      existing={{
        id: post.id,
        title: post.title,
        description: post.description,
        content: post.content,
        tag: post.tag,
        isPublished: post.isPublished,
      }}
    />
  );
}
