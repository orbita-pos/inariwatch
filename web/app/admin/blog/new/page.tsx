import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { notFound } from "next/navigation";
import { PostEditor } from "../post-editor";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "New post — Blog Admin" };

export default async function NewPostPage() {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string })?.email;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail || email !== adminEmail) notFound();

  return <PostEditor />;
}
