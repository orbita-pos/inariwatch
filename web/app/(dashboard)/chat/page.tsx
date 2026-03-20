import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, apiKeys, users } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { ProGate } from "@/components/pro-gate";
import { ChatInterface } from "./chat-interface";

export const metadata: Metadata = { title: "Ask Inari" };

export default async function ChatPage() {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;
  if (!userId) redirect("/login");

  const hasAIKey = (
    await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), inArray(apiKeys.service, ["claude", "openai", "grok", "deepseek", "gemini"])))
      .limit(1)
  ).length > 0;

  return (
    <div className="mx-auto flex h-full max-w-[780px] flex-col">
      <ProGate feature="Ask Inari">
        <ChatInterface hasAIKey={hasAIKey} />
      </ProGate>
    </div>
  );
}
