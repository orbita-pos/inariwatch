import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let event: Stripe.Event;

  try {
    const rawBody = await req.text();
    const signature = req.headers.get("stripe-signature");

    if (!signature) {
      return NextResponse.json({ error: "Missing stripe-signature header." }, { status: 400 });
    }

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (err: any) {
    console.error("[stripe/webhook] Signature verification failed:", err.message);
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.userId;
        const plan = session.metadata?.plan as "pro" | "team" | undefined;

        if (!userId || !plan) {
          console.error("[stripe/webhook] Missing metadata on checkout session:", session.id);
          break;
        }

        await db
          .update(users)
          .set({
            plan,
            stripeCustomerId: session.customer as string,
            stripeSubId: session.subscription as string,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));

        console.log(`[stripe/webhook] User ${userId} upgraded to ${plan}`);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        await db
          .update(users)
          .set({
            plan: "free",
            stripeSubId: null,
            updatedAt: new Date(),
          })
          .where(eq(users.stripeCustomerId, customerId));

        console.log(`[stripe/webhook] Customer ${customerId} downgraded to free (subscription deleted)`);
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;
        const priceId = subscription.items.data[0]?.price?.id;

        // Determine plan from price ID
        let plan: "pro" | "team" | null = null;
        if (priceId === process.env.STRIPE_PRO_PRICE_ID) plan = "pro";
        else if (priceId === process.env.STRIPE_TEAM_PRICE_ID) plan = "team";

        if (plan) {
          await db
            .update(users)
            .set({
              plan,
              stripeSubId: subscription.id,
              updatedAt: new Date(),
            })
            .where(eq(users.stripeCustomerId, customerId));

          console.log(`[stripe/webhook] Customer ${customerId} plan updated to ${plan}`);
        }
        break;
      }

      default:
        // Unhandled event type — ignore silently
        break;
    }
  } catch (err: any) {
    console.error("[stripe/webhook] Error processing event:", err);
    return NextResponse.json({ error: "Webhook handler failed." }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
