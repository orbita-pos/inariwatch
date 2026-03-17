import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects } from "@/lib/db";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { OnboardingWizard } from "./wizard";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Get Started" };

export default async function OnboardingPage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) redirect("/login");

  const userProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.userId, userId))
    .limit(1);

  if (userProjects.length > 0) {
    redirect("/dashboard");
  }

  const userName = session?.user?.name?.split(" ")[0] ?? "there";

  return <OnboardingWizard userName={userName} />;
}
