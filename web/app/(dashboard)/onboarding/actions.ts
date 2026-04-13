"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, users, PLAN_LIMITS } from "@/lib/db";
import { eq, count } from "drizzle-orm";
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

    // Plan limit check — same logic as web/app/(dashboard)/projects/actions.ts
    // (the dashboard "create project" path). Onboarding is the first place
    // a free user creates a project, so this is also the first place we can
    // surface the limit.
    const [owner] = await db
      .select({ plan: users.plan })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const plan = "pro"; // Beta: all users get Pro limits
    const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

    const [projectCount] = await db
      .select({ count: count() })
      .from(projects)
      .where(eq(projects.userId, userId));

    if (projectCount.count >= limits.maxProjects) {
      return {
        error: `Your ${plan} plan allows ${limits.maxProjects} projects. Upgrade to Pro for ${PLAN_LIMITS.pro.maxProjects}.`,
      };
    }

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
