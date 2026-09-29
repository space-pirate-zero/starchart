// @ts-nocheck
import Stripe from "stripe";
import { track } from "../../../lib/analytics";
import { PRICE_ID } from "@/lib/pricing";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");

export async function POST(request: Request) {
  const secret = process.env["STRIPE_WEBHOOK_SECRET"];
  track("checkout_started");
  const session = await stripe.checkout.sessions.create({ line_items: [{ price: PRICE_ID, quantity: 1 }] });
  return Response.json({ url: session.url, secret: Boolean(secret) });
}
