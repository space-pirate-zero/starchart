// @starchart anchors addon:pro.name
export const PRO_NAME = "Nebula Pro";
export const PRO_PRICE_USD = 4.99;
export const PRO_FEATURES = ["Themes", "iCloud sync"];

export function formatPrice(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
