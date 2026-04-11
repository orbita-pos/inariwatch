import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";
import { stripe, isStripeConfigured, STRIPE_PRICE_PRO_MONTHLY, STRIPE_PRICE_PRO_ANNUAL } from "@/lib/stripe";

/**
 * POST /api/billing/checkout
 *
 * Create a Stripe Checkout session for the Pro plan.
 *
 * Body:
 *   { interval: "monthly" | "annual" }
 *
 * Returns:
 *   { url: "https://checkout.stripe.com/c/pay/..." }
 *
 * The user is redirected to Stripe Checkout. After payment, Stripe sends
 * a webhook to /api/billing/webhook which activates their Pro plan.
 */
export async function POST(req: Request) {
  if (!isStripeConfigured() || !stripe) {
    return NextResponse.json(
      { error: "Billing is not configured. Set STRIPE_SECRET_KEY and price IDs." },
      { status: 503 }
    );
  }

  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  const userEmail = (session?.user as { email?: string })?.email;
  if (!userId || !userEmail) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { interval?: "monthly" | "annual" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const interval = body.interval ?? "monthly";
  if (interval !== "monthly" && interval !== "annual") {
    return NextResponse.json({ error: "Invalid interval" }, { status: 400 });
  }

  const priceId = interval === "annual" ? STRIPE_PRICE_PRO_ANNUAL : STRIPE_PRICE_PRO_MONTHLY;

  // Get or create Stripe customer
  const [user] = await db
    .select({ id: users.id, stripeCustomerId: users.stripeCustomerId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  let customerId = user.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: userEmail,
      metadata: { userId },
    });
    customerId = customer.id;

    await db
      .update(users)
      .set({ stripeCustomerId: customerId })
      .where(eq(users.id, userId));
  }

  const baseUrl =
    process.env.NEXTAUTH_URL ??
    process.env.APP_URL ??
    "https://app.inariwatch.com";

  const checkoutSession = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/settings/billing?success=true`,
    cancel_url: `${baseUrl}/pricing?canceled=true`,
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    metadata: { userId, interval },
    subscription_data: {
      metadata: { userId, interval },
    },
  });

  if (!checkoutSession.url) {
    return NextResponse.json({ error: "Failed to create checkout session" }, { status: 500 });
  }

  return NextResponse.json({ url: checkoutSession.url });
}
