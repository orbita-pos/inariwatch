"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects } from "@/lib/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function createProjectForOnboarding(
  name: string
): Promise<{ projectId?: string; error?: string }> {
  try {
    const session = await getServerSession(authOptions);
    const userId = (session?.user as { id?: string })?.id;
    if (!userId) return { error: "Not authenticated." };

    const trimmed = name.trim();
    if (!trimmed) return { error: "Project name is required." };

    const slug = trimmed
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 48);

    const [inserted] = await db
      .insert(projects)
      .values({ userId, name: trimmed, slug })
      .returning({ id: projects.id });

    revalidatePath("/projects");
    revalidatePath("/integrations");

    return { projectId: inserted.id };
  } catch (err: any) {
    if (err?.message?.includes("unique"))
      return { error: "A project with that name already exists." };
    return { error: "Failed to create project. Please try again." };
  }
}
