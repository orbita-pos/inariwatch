import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projectInvites, projectMembers, users } from "@/lib/db";
import { eq, and } from "drizzle-orm";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;

  if (!userId) {
    // Redirect to login with return URL
    const loginUrl = `/login?callbackUrl=${encodeURIComponent(`/api/invites/${token}`)}`;
    return NextResponse.redirect(new URL(loginUrl, process.env.NEXTAUTH_URL ?? "http://localhost:3000"));
  }

  // Find the invite
  const [invite] = await db
    .select()
    .from(projectInvites)
    .where(eq(projectInvites.token, token))
    .limit(1);

  if (!invite) {
    return NextResponse.redirect(
      new URL("/dashboard?error=invite_not_found", process.env.NEXTAUTH_URL ?? "http://localhost:3000")
    );
  }

  // Check expiration
  if (new Date() > invite.expiresAt) {
    // Clean up expired invite
    await db.delete(projectInvites).where(eq(projectInvites.id, invite.id));
    return NextResponse.redirect(
      new URL("/dashboard?error=invite_expired", process.env.NEXTAUTH_URL ?? "http://localhost:3000")
    );
  }

  // Get the user's email to verify it matches
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || user.email.toLowerCase() !== invite.email.toLowerCase()) {
    return NextResponse.redirect(
      new URL("/dashboard?error=invite_email_mismatch", process.env.NEXTAUTH_URL ?? "http://localhost:3000")
    );
  }

  // Check if already a member
  const [existing] = await db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, invite.projectId),
        eq(projectMembers.userId, userId)
      )
    )
    .limit(1);

  if (!existing) {
    // Add as member
    await db.insert(projectMembers).values({
      projectId: invite.projectId,
      userId,
      role: invite.role,
      invitedBy: invite.invitedBy,
      acceptedAt: new Date(),
    });
  }

  // Delete the invite
  await db.delete(projectInvites).where(eq(projectInvites.id, invite.id));

  return NextResponse.redirect(
    new URL("/dashboard?invite=accepted", process.env.NEXTAUTH_URL ?? "http://localhost:3000")
  );
}
