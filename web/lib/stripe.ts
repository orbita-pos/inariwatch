import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export const PRICE_IDS = {
  pro: process.env.STRIPE_PRO_PRICE_ID!,
} as const;
