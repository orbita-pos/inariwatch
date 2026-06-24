import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { OnboardingWizard } from "./wizard";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Get Started" };

export default async function OnboardingPage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) redirect("/login");

  const userName = session?.user?.name?.split(" ")[0] ?? "there";

  // When the GitHub App is provisioned, the wizard's step 1 offers
  // "Import from GitHub" as the primary CTA — Vercel-style. Empty / unset
  // → user creates a blank project manually as before.
  const githubAppSlug = process.env.GITHUB_APP_SLUG ?? "";

  return <OnboardingWizard userName={userName} githubAppSlug={githubAppSlug} />;
}
