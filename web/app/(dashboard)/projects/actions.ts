"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, users, PLAN_LIMITS } from "@/lib/db";
import { eq, and, count } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function createProject(
  formData: FormData
): Promise<{ error?: string }> {
  try {
    const session = await getServerSession(authOptions);
    const userId = (session?.user as { id?: string })?.id;
    if (!userId) return { error: "Not authenticated." };

    const name = (formData.get("name") as string)?.trim();
    if (!name) return { error: "Project name is required." };

    // ── Plan limit check ─────────────────────────────────────────────────────
    const [user] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, userId)).limit(1);
    const plan = user?.plan ?? "free";
    const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

    const [projectCount] = await db
      .select({ count: count() })
      .from(projects)
      .where(eq(projects.userId, userId));

    if (projectCount.count >= limits.maxProjects) {
      return {
        error: `Your ${plan} plan allows ${limits.maxProjects} projects. Upgrade to ${plan === "free" ? "Pro" : "Team"} for more.`,
      };
    }

    const slug = name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 48);

    const description    = (formData.get("description") as string)?.trim() || null;
    const organizationId = (formData.get("organizationId") as string)?.trim() || null;

    await db.insert(projects).values({ userId, name, slug, description, organizationId });

    revalidatePath("/projects");
    revalidatePath("/integrations");
    revalidatePath("/dashboard");
    return {};
  } catch (err: any) {
    if (err?.message?.includes("unique"))
      return { error: "A project with that name already exists." };
    return { error: "Failed to create project. Please try again." };
  }
}

export async function deleteProject(projectId: string): Promise<void> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return;

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) return;

  await db.delete(projects).where(eq(projects.id, projectId));
  revalidatePath("/projects");
  revalidatePath("/dashboard");
}
