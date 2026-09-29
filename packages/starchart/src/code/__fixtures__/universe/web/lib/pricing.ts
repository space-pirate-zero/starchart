// @ts-nocheck
/** Prices shown on the website. */

// @starchart anchors addon:pro.price.usd
export const PRO_PRICE_USD = 4.99;

export const PRO_FEATURES = ["themes", "sync"] as const;

export const PRICE_ID = "price_1ProMonthly499";

export const PLANS = {
  pro: { usd: 4.99, name: "Nebula Pro" },
  free: { usd: 0 },
} as const;

// @starchart frobnicates addon:pro
export function formatPrice(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export const DISPLAY_PRICE = formatPrice(PRO_PRICE_USD);
