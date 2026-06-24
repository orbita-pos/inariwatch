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
  const rl = await rateLimit("create-org", userId, { windowMs: 3_600_000, max: 5 });
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
  const rl = await rateLimit("invite-member", userId, { windowMs: 3_600_000, max: 20 });
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
    `You're invited to join ${rawOrgName} on InariWatch`,
    `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;">

          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:3px;color:#7C3AED;">INARIWATCH</span>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#ffffff;border-radius:12px;border:1px solid #e4e4e7;padding:36px 40px;">

              <!-- Heading -->
              <h2 style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:20px;font-weight:600;color:#09090b;margin:0 0 12px 0;">
                You&apos;re invited to join ${safeOrgName}
              </h2>

              <!-- Body -->
              <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.7;color:#3f3f46;margin:0 0 28px 0;">
                <strong style="color:#09090b;">${safeInviterName}</strong> has invited you to join
                <strong style="color:#09090b;">${safeOrgName}</strong> as a <strong style="color:#09090b;">${safeRole}</strong> on InariWatch.
              </p>

              <!-- CTA -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background-color:#7C3AED;border-radius:8px;">
                    <a href="${inviteUrl}" target="_blank"
                       style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#ffffff;padding:12px 28px;text-decoration:none;">
                      Accept invitation
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Divider -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;">
                <tr><td style="border-top:1px solid #e4e4e7;font-size:0;line-height:0;" height="1">&nbsp;</td></tr>
              </table>

              <!-- Footer note -->
              <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#71717a;margin:20px 0 0 0;">
                This invite expires in 7 days. If you weren&apos;t expecting this, you can safely ignore it.
              </p>
            </td>
          </tr>

          <!-- Bottom brand -->
          <tr>
            <td align="center" style="padding-top:24px;">
              <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#a1a1aa;margin:0;">
                &copy; InariWatch &mdash; Proactive developer monitoring
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
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
