import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, apiKeys } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { ChatInterface } from "./chat-interface";

export const metadata: Metadata = { title: "Ask Inari" };

export default async function ChatPage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) redirect("/login");

  const hasAIKey = (
    await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), inArray(apiKeys.service, ["claude", "openai"])))
      .limit(1)
  ).length > 0;

  return (
    <div className="mx-auto max-w-[780px] h-[calc(100vh-theme(spacing.16))] flex flex-col">
      <ChatInterface hasAIKey={hasAIKey} />
    </div>
  );
}
