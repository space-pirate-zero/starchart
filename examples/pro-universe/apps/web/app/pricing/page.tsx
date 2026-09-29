import posthog from "posthog-js";
import { PRO_FEATURES, PRO_NAME, PRO_PRICE_USD, formatPrice } from "@/lib/pricing";

export default function PricingPage() {
  return (
    <main>
      <h1>{PRO_NAME}</h1>
      <p className="price">$4.99 / month</p>
      <p>Only {formatPrice(PRO_PRICE_USD)} a month. Cancel anytime.</p>
      <ul>
        {PRO_FEATURES.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <button onClick={() => posthog.capture("pro_checkout_started")}>Go Pro</button>
    </main>
  );
}
