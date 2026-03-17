import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { stripe, PRICE_IDS } from "@/lib/stripe";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    const userId = (session?.user as { id?: string })?.id;
    const email = session?.user?.email;

    if (!userId || !email) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const body = await req.json();
    const plan = body.plan as string;

    if (plan !== "pro" && plan !== "team") {
      return NextResponse.json({ error: "Invalid plan. Must be 'pro' or 'team'." }, { status: 400 });
    }

    const priceId = PRICE_IDS[plan];
    if (!priceId) {
      return NextResponse.json({ error: "Price not configured for this plan." }, { status: 500 });
    }

    const origin = req.headers.get("origin") ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000";

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/settings?upgrade=success`,
      cancel_url: `${origin}/settings`,
      metadata: { userId, plan },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err: any) {
    console.error("[stripe/checkout] Error:", err);
    return NextResponse.json(
      { error: err.message ?? "Failed to create checkout session." },
      { status: 500 },
    );
  }
}
