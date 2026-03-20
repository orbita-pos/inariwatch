"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, organizations, organizationMembers, organizationInvites, users } from "@/lib/db";
import { eq, and, gt } from "drizzle-orm";
import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { sendEmail } from "@/lib/notifications/email";
import { rateLimit } from "@/lib/auth-rate-limit";

const APP_URL = process.env.NEXTAUTH_URL ?? "https://app.inariwatch.com";

// ── HTML escaping for email templates ────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Create organization ──────────────────────────────────────────────────────

export async function createOrganization(
  name: string
): Promise<{ id?: string; error?: string }> {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  // Rate limit: max 5 orgs created per hour per user
  const rl = rateLimit("create-org", userId, { windowMs: 3_600_000, max: 5 });
  if (!rl.allowed) return { error: `Too many requests. Try again in ${rl.retryAfterSeconds}s.` };

  const trimmed = name.trim();
  if (!trimmed || trimmed.length < 2) return { error: "Name must be at least 2 characters." };
  if (trimmed.length > 40) return { error: "Name must be 40 characters or less." };

  const slug = trimmed
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 48);

  if (!slug) return { error: "Invalid name." };

  try {
    const [org] = await db
      .insert(organizations)
      .values({ name: trimmed, slug, ownerId: userId })
      .returning({ id: organizations.id });

    // Add owner as a member too (simplifies queries)
    await db.insert(organizationMembers).values({
      organizationId: org.id,
      userId,
      role: "owner",
    });

    revalidatePath("/dashboard");
    return { id: org.id };
  } catch (err: any) {
    if (err?.message?.includes("unique"))
      return { error: "A workspace with that name already exists." };
    return { error: "Failed to create workspace." };
  }
}

// ── Invite member ────────────────────────────────────────────────────────────

export async function inviteMember(
  organizationId: string,
  email: string,
  role: "admin" | "member" = "member"
): Promise<{ ok?: boolean; error?: string }> {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  // [HIGH] Runtime role validation — prevent "owner" injection from client
  if (role !== "admin" && role !== "member") return { error: "Invalid role." };

  // Rate limit: max 20 invites per hour per user
  const rl = rateLimit("invite-member", userId, { windowMs: 3_600_000, max: 20 });
  if (!rl.allowed) return { error: `Too many invites. Try again in ${rl.retryAfterSeconds}s.` };

  const emailTrimmed = email.trim().toLowerCase();
  if (!emailTrimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrimmed))
    return { error: "Enter a valid email." };

  // Verify user owns or is admin of this org
  const [org] = await db
    .select({ ownerId: organizations.ownerId })
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  if (!org) return { error: "Workspace not found." };

  if (org.ownerId !== userId) {
    const [memberRow] = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ));
    if (!memberRow || (memberRow.role !== "owner" && memberRow.role !== "admin"))
      return { error: "You don't have permission to invite members." };
  }

  // Check if user exists and if they are already a member
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, emailTrimmed));

  // [NEW] Enforce that invited users must already have an account
  if (!existingUser) {
    return { error: "This email is not registered. They must create an account first." };
  }

  // They exist, now check if they are already in the org
  const [alreadyMember] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(and(
      eq(organizationMembers.organizationId, organizationId),
      eq(organizationMembers.userId, existingUser.id),
    ));
    
  if (alreadyMember) return { error: "This user is already a member." };

  // [MEDIUM] Check if invite already pending — only non-expired invites
  const [existingInvite] = await db
    .select({ id: organizationInvites.id })
    .from(organizationInvites)
    .where(and(
      eq(organizationInvites.organizationId, organizationId),
      eq(organizationInvites.email, emailTrimmed),
      gt(organizationInvites.expiresAt, new Date()),
    ));

  if (existingInvite) return { error: "An invite for this email is already pending." };

  // Create invite
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await db.insert(organizationInvites).values({
    organizationId,
    email: emailTrimmed,
    role,
    invitedBy: userId,
    token,
    expiresAt,
  });

  // Fetch org name for email
  const [orgInfo] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  // [HIGH] Escape all dynamic values for HTML email
  const rawInviterName = session?.user?.name ?? session?.user?.email ?? "Someone";
  const rawOrgName = orgInfo?.name ?? "the workspace";
  const safeInviterName = escapeHtml(rawInviterName);
  const safeOrgName = escapeHtml(rawOrgName);
  const safeRole = escapeHtml(role);
  const inviteUrl = `${APP_URL}/invite/${token}`;

  // Send invite email
  const emailResult = await sendEmail(
    { email: emailTrimmed },
    `You're invited to ${rawOrgName} on InariWatch`,
    `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <div style="margin-bottom: 24px;">
        <span style="color: #7C3AED; font-weight: 700; font-size: 14px; letter-spacing: 2px; font-family: monospace;">INARIWATCH</span>
      </div>
      <h2 style="color: #f4f4f5; font-size: 20px; margin-bottom: 8px;">
        Join ${safeOrgName}
      </h2>
      <p style="color: #a1a1aa; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
        <strong style="color: #d4d4d8;">${safeInviterName}</strong> has invited you to join
        <strong style="color: #d4d4d8;">${safeOrgName}</strong> as a ${safeRole} on InariWatch.
      </p>
      <a href="${inviteUrl}"
         style="display: inline-block; background: #7C3AED; color: #fff; font-weight: 600; font-size: 14px;
                padding: 12px 28px; border-radius: 8px; text-decoration: none; margin-bottom: 24px;">
        Accept invitation
      </a>
      <p style="color: #52525b; font-size: 12px; margin-top: 24px;">
        This invite expires in 7 days.
      </p>
    </div>
    `
  );

  // [LOW] Check if email delivery failed
  if (emailResult && "ok" in emailResult && !emailResult.ok) {
    console.error("[inviteMember] Email delivery failed for", emailTrimmed);
  }

  return { ok: true };
}

// ── Accept invite ────────────────────────────────────────────────────────────

export async function acceptInvite(
  token: string
): Promise<{ orgId?: string; error?: string }> {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;
  const userEmail = (session?.user?.email ?? "").toLowerCase();
  if (!userId) return { error: "Sign in to accept this invite." };

  const [invite] = await db
    .select()
    .from(organizationInvites)
    .where(eq(organizationInvites.token, token));

  if (!invite) return { error: "Invite not found or already used." };
  if (new Date() > invite.expiresAt) return { error: "This invite has expired." };

  // [HIGH] Verify the accepting user's email matches the invited email
  if (userEmail !== invite.email.toLowerCase()) {
    return { error: "This invite was sent to a different email address. Sign in with the correct account." };
  }

  // Check not already a member
  const [existing] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(and(
      eq(organizationMembers.organizationId, invite.organizationId),
      eq(organizationMembers.userId, userId),
    ));

  if (existing) {
    // Already a member, just delete the invite
    await db.delete(organizationInvites).where(eq(organizationInvites.id, invite.id));
    return { orgId: invite.organizationId };
  }

  // [LOW] Sequential instead of parallel to avoid partial failure
  await db.insert(organizationMembers).values({
    organizationId: invite.organizationId,
    userId,
    role: invite.role,
  });
  await db.delete(organizationInvites).where(eq(organizationInvites.id, invite.id));

  revalidatePath("/dashboard");
  return { orgId: invite.organizationId };
}
