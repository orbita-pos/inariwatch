import { NextResponse } from "next/server";
import { db, users, processedWebhookEvents } from "@/lib/db";
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

  // Idempotency check — skip if we've already processed this event
  try {
    const inserted = await db
      .insert(processedWebhookEvents)
      .values({
        eventId: event.id,
        source: "stripe",
        eventType: event.type,
      })
      .onConflictDoNothing({ target: processedWebhookEvents.eventId })
      .returning({ id: processedWebhookEvents.eventId });

    if (inserted.length === 0) {
      // Already processed — return 200 so Stripe stops retrying
      return NextResponse.json({ received: true, duplicate: true });
    }
  } catch (err) {
    console.error("[stripe-webhook] dedup check failed:", err);
    // Continue anyway — it's better to risk double-processing than to fail
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
            const [u] = await db
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, userId))
              .limit(1);
            await db
              .update(users)
              .set({ subscriptionStatus: "past_due" })
              .where(eq(users.id, userId));

            if (u?.email) {
              import("@/lib/notifications/billing-email").then(({ sendPaymentFailedEmail }) => {
                sendPaymentFailedEmail(u.email, {
                  updateUrl: invoice.hosted_invoice_url ?? undefined,
                }).catch(() => {});
              }).catch(() => {});
            }
          }
        }
        break;
      }

      case "invoice.payment_succeeded": {
        // Send renewal email for recurring payments (skip first invoice which
        // is part of activation — that gets the welcome email instead).
        const invoice = event.data.object as Stripe.Invoice;
        const billingReason = (invoice as Stripe.Invoice & { billing_reason?: string }).billing_reason;
        if (billingReason !== "subscription_cycle") break;

        const subscriptionId = (invoice as Stripe.Invoice & { subscription?: string }).subscription;
        if (typeof subscriptionId === "string") {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const userId = subscription.metadata?.userId
            ?? (await getUserIdFromCustomerId(subscription.customer as string));
          if (userId) {
            const [u] = await db
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, userId))
              .limit(1);
            const periodEnd = (subscription as Stripe.Subscription & { current_period_end?: number }).current_period_end;

            if (u?.email && periodEnd) {
              import("@/lib/notifications/billing-email").then(({ sendRenewalEmail }) => {
                sendRenewalEmail(u.email, {
                  amount: invoice.amount_paid ?? 0,
                  nextBillingDate: new Date(periodEnd * 1000),
                  invoiceUrl: invoice.hosted_invoice_url ?? undefined,
                }).catch(() => {});
              }).catch(() => {});
            }
          }
        }
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

  // Detect first-time activation so we send the welcome email exactly once.
  const [existing] = await db
    .select({ plan: users.plan, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const wasFree = existing?.plan !== "pro";

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

  // Welcome email on first activation only
  if (wasFree && existing?.email && periodEnd) {
    import("@/lib/notifications/billing-email").then(({ sendProWelcomeEmail }) => {
      sendProWelcomeEmail(existing.email, {
        interval: subscription.metadata?.interval === "annual" ? "annual" : "monthly",
        nextBillingDate: new Date(periodEnd * 1000),
      }).catch((err) => console.error("[billing] welcome email failed:", err));
    }).catch(() => {});
  }
}

async function downgradeToFree(userId: string, subscription: Stripe.Subscription) {
  const [existing] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  await db
    .update(users)
    .set({
      plan: "free",
      subscriptionStatus: subscription.status,
      subscriptionCancelAtPeriodEnd: false,
    })
    .where(eq(users.id, userId));

  // Cancellation confirmation email
  if (existing?.email) {
    const periodEnd = (subscription as Stripe.Subscription & { current_period_end?: number }).current_period_end;
    const effectiveDate = periodEnd ? new Date(periodEnd * 1000) : new Date();
    import("@/lib/notifications/billing-email").then(({ sendSubscriptionCanceledEmail }) => {
      sendSubscriptionCanceledEmail(existing.email, { effectiveDate }).catch(() => {});
    }).catch(() => {});
  }
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
