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

  return <OnboardingWizard userName={userName} />;
}
