import { PRICE_PRO_MONTHLY, stripe } from "@/lib/stripe";

export async function POST(request: Request) {
  const { origin } = new URL(request.url);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: PRICE_PRO_MONTHLY, quantity: 1 }],
    success_url: `${origin}/welcome`,
    cancel_url: `${origin}/pricing`,
  });
  return Response.json({ url: session.url });
}
