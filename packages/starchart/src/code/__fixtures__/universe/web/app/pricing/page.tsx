// @ts-nocheck
import posthog from "posthog-js";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { useTranslations } from "next-intl";
import { PLANS, PRO_FEATURES, PRO_PRICE_USD } from "@/lib/pricing";
import { fmt } from "@/lib";

export const metadata = { title: "Pricing" };

export default function PricingPage() { // @starchart publishes web:pricing-page
  const t = useTranslations("pricing");
  const showNew = useFeatureFlagEnabled("new-paywall");
  return (
    <main>
      {/* @starchart displays addon:pro.price */}
      <h1>{t("title")}</h1>
      <p>{fmt(PRO_PRICE_USD)} or {PLANS.pro.usd}</p>
      <ul>{PRO_FEATURES.map((f) => <li key={f}>{f}</li>)}</ul>
      <button onClick={() => posthog.capture("pricing_viewed")}>{showNew ? "Go" : "Buy"}</button>
    </main>
  );
}
