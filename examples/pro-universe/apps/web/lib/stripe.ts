import Stripe from "stripe";

// @starchart anchors stripe:price/pro-monthly
export const PRICE_PRO_MONTHLY = "price_1NebulaPro499";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
