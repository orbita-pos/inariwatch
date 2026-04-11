/**
 * Stripe client + product configuration.
 *
 * Pricing:
 *   Pro Monthly: $12/mo
 *   Pro Annual:  $120/yr (2 months free vs 12*$12=$144)
 *
 * Set these env vars in production:
 *   STRIPE_SECRET_KEY              — sk_live_... or sk_test_...
 *   STRIPE_WEBHOOK_SECRET          — whsec_...
 *   STRIPE_PRICE_PRO_MONTHLY       — price_... from Stripe dashboard
 *   STRIPE_PRICE_PRO_ANNUAL        — price_... from Stripe dashboard
 *   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY — pk_live_... (for client-side if needed)
 */

import Stripe from "stripe";

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!SECRET_KEY && process.env.NODE_ENV === "production") {
  console.warn("[stripe] STRIPE_SECRET_KEY not set — checkout will fail");
}

export const stripe = SECRET_KEY
  ? new Stripe(SECRET_KEY, {
      apiVersion: "2026-03-25.dahlia",
      typescript: true,
      maxNetworkRetries: 2,
      timeout: 10_000,
    })
  : null;

export const STRIPE_PRICE_PRO_MONTHLY = process.env.STRIPE_PRICE_PRO_MONTHLY ?? "";
export const STRIPE_PRICE_PRO_ANNUAL = process.env.STRIPE_PRICE_PRO_ANNUAL ?? "";

export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

/** Constants used in webhook handlers and checkout config. */
export const PRO_PRODUCT = {
  monthly: {
    priceId: STRIPE_PRICE_PRO_MONTHLY,
    amount: 1200, // cents
    interval: "month" as const,
    label: "Pro Monthly",
  },
  annual: {
    priceId: STRIPE_PRICE_PRO_ANNUAL,
    amount: 12000, // cents
    interval: "year" as const,
    label: "Pro Annual",
  },
};

export function isStripeConfigured(): boolean {
  return Boolean(stripe && STRIPE_PRICE_PRO_MONTHLY && STRIPE_PRICE_PRO_ANNUAL);
}
