import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, users } from "@/lib/db";
import { and, eq, isNull } from "drizzle-orm";
import { stripe, isStripeConfigured, STRIPE_PRICE_PRO_MONTHLY, STRIPE_PRICE_PRO_ANNUAL } from "@/lib/stripe";
import { checkWebhookRateLimit, extractClientIp } from "@/lib/webhooks/rate-limit";

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
  // Rate limit: 10 checkout attempts per minute per IP — prevents Stripe
  // customer creation spam.
  const ip = extractClientIp(req);
  const rl = await checkWebhookRateLimit(ip, 60_000, 10);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } }
    );
  }

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
    // Race-safe customer creation: create the Stripe customer, then atomically
    // claim it. If we lose the race against a concurrent request, delete our
    // orphan and use the winner's customer instead.
    const customer = await stripe.customers.create({
      email: userEmail,
      metadata: { userId },
    });

    const claimed = await db
      .update(users)
      .set({ stripeCustomerId: customer.id })
      .where(and(eq(users.id, userId), isNull(users.stripeCustomerId)))
      .returning({ stripeCustomerId: users.stripeCustomerId });

    if (claimed.length === 0) {
      // Lost the race — another concurrent request already set one.
      // Delete our orphan customer in Stripe and re-fetch the winner.
      try {
        await stripe.customers.del(customer.id);
      } catch (delErr) {
        console.error("[checkout] failed to delete orphan customer:", delErr);
      }
      const [refreshed] = await db
        .select({ stripeCustomerId: users.stripeCustomerId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      customerId = refreshed?.stripeCustomerId ?? null;
    } else {
      customerId = claimed[0].stripeCustomerId;
    }

    if (!customerId) {
      return NextResponse.json(
        { error: "Failed to create or claim customer" },
        { status: 500 }
      );
    }
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
