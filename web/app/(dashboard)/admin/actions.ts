"use server";

import { db, notificationQueue } from "@/lib/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { notFound } from "next/navigation";

export async function retryDeadNotification(id: string) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email || email !== process.env.ADMIN_EMAIL) {
    notFound();
  }

  await db
    .update(notificationQueue)
    .set({ status: "pending", attempts: 0, error: null, nextRetry: new Date() })
    .where(eq(notificationQueue.id, id));

  revalidatePath("/admin");
}
