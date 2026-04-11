import { NextResponse } from "next/server";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";
import { stripe, STRIPE_WEBHOOK_SECRET } from "@/lib/stripe";
import type Stripe from "stripe";

/**
 * POST /api/billing/webhook
 *
 * Stripe webhook handler. Activates Pro plan on successful checkout,
 * downgrades to Free on cancellation, updates subscription status.
 *
 * Configure in Stripe Dashboard:
 *   Events:
 *     - checkout.session.completed
 *     - customer.subscription.created
 *     - customer.subscription.updated
 *     - customer.subscription.deleted
 *     - invoice.payment_failed
 *     - invoice.payment_succeeded
 *   URL: https://app.inariwatch.com/api/billing/webhook
 */
export async function POST(req: Request) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid signature";
    return NextResponse.json({ error: `Webhook signature verification failed: ${msg}` }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.userId;
        if (!userId) break;

        // Fetch the subscription details
        if (typeof session.subscription === "string") {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          await activateProPlan(userId, subscription);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.userId
          ?? (await getUserIdFromCustomerId(subscription.customer as string));
        if (!userId) break;

        if (subscription.status === "active" || subscription.status === "trialing") {
          await activateProPlan(userId, subscription);
        } else if (subscription.status === "canceled" || subscription.status === "unpaid") {
          await downgradeToFree(userId, subscription);
        } else {
          // past_due, incomplete, etc — keep status but mark as such
          await updateSubscriptionStatus(userId, subscription);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.userId
          ?? (await getUserIdFromCustomerId(subscription.customer as string));
        if (!userId) break;
        await downgradeToFree(userId, subscription);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = (invoice as Stripe.Invoice & { subscription?: string }).subscription;
        if (typeof subscriptionId === "string") {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const userId = subscription.metadata?.userId
            ?? (await getUserIdFromCustomerId(subscription.customer as string));
          if (userId) {
            await db
              .update(users)
              .set({ subscriptionStatus: "past_due" })
              .where(eq(users.id, userId));
          }
        }
        break;
      }

      case "invoice.payment_succeeded": {
        // Just log — we already handle activation via subscription events
        break;
      }

      default:
        // Unhandled event — that's fine
        break;
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("[stripe-webhook] handler error:", err);
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function activateProPlan(userId: string, subscription: Stripe.Subscription) {
  const periodEnd = (subscription as Stripe.Subscription & { current_period_end?: number }).current_period_end;
  await db
    .update(users)
    .set({
      plan: "pro",
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      subscriptionPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      subscriptionCancelAtPeriodEnd: subscription.cancel_at_period_end,
    })
    .where(eq(users.id, userId));
}

async function downgradeToFree(userId: string, subscription: Stripe.Subscription) {
  await db
    .update(users)
    .set({
      plan: "free",
      subscriptionStatus: subscription.status,
      subscriptionCancelAtPeriodEnd: false,
    })
    .where(eq(users.id, userId));
}

async function updateSubscriptionStatus(userId: string, subscription: Stripe.Subscription) {
  const periodEnd = (subscription as Stripe.Subscription & { current_period_end?: number }).current_period_end;
  await db
    .update(users)
    .set({
      subscriptionStatus: subscription.status,
      subscriptionPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      subscriptionCancelAtPeriodEnd: subscription.cancel_at_period_end,
    })
    .where(eq(users.id, userId));
}

async function getUserIdFromCustomerId(customerId: string): Promise<string | null> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1);
  return user?.id ?? null;
}
