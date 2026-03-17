import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, organizationInvites, organizations } from "@/lib/db";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { AcceptInviteCard } from "./accept-card";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Accept Invite — InariWatch" };

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Fetch invite + org info
  const [invite] = await db
    .select({
      id:             organizationInvites.id,
      organizationId: organizationInvites.organizationId,
      email:          organizationInvites.email,
      role:           organizationInvites.role,
      expiresAt:      organizationInvites.expiresAt,
      orgName:        organizations.name,
    })
    .from(organizationInvites)
    .innerJoin(organizations, eq(organizationInvites.organizationId, organizations.id))
    .where(eq(organizationInvites.token, token));

  if (!invite) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page px-6">
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-bold text-fg-strong mb-2">Invite not found</h1>
          <p className="text-sm text-fg-base mb-6">This invite link may have been used or is invalid.</p>
          <a href="/login" className="text-sm text-inari-accent hover:underline">Go to sign in</a>
        </div>
      </div>
    );
  }

  const expired = new Date() > invite.expiresAt;

  if (expired) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page px-6">
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-bold text-fg-strong mb-2">Invite expired</h1>
          <p className="text-sm text-fg-base mb-6">Ask the workspace admin to send you a new invite.</p>
          <a href="/login" className="text-sm text-inari-accent hover:underline">Go to sign in</a>
        </div>
      </div>
    );
  }

  const session = await getServerSession(authOptions);

  // Not signed in → redirect to login with callback
  if (!session) {
    redirect(`/login?callbackUrl=/invite/${token}`);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-page px-6">
      <AcceptInviteCard
        token={token}
        orgName={invite.orgName}
        role={invite.role}
        email={invite.email}
      />
    </div>
  );
}
