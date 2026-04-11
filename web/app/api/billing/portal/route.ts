import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";
import { stripe, isStripeConfigured } from "@/lib/stripe";

/**
 * POST /api/billing/portal
 *
 * Create a Stripe Customer Portal session — lets the user manage their
 * subscription (update card, cancel, view invoices) without us building
 * the UI.
 */
export async function POST() {
  if (!isStripeConfigured() || !stripe) {
    return NextResponse.json({ error: "Billing not configured" }, { status: 503 });
  }

  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [user] = await db
    .select({ stripeCustomerId: users.stripeCustomerId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user?.stripeCustomerId) {
    return NextResponse.json({ error: "No subscription found" }, { status: 404 });
  }

  const baseUrl =
    process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? "https://app.inariwatch.com";

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${baseUrl}/settings/billing`,
  });

  return NextResponse.json({ url: portalSession.url });
}
