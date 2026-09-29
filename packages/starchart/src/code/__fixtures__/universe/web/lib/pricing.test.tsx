// @ts-nocheck
import { describe, expect, it } from "vitest";
import { formatPrice, PRO_PRICE_USD } from "./pricing";

describe("formatPrice", () => {
  it("formats the pro price", () => {
    expect(formatPrice(PRO_PRICE_USD)).toBe("$4.99");
  });
});
