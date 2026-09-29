import { beforeAll, describe, expect, it } from "vitest";

interface Match {
  start: number;
  end: number;
  factId: string | null;
  status: "sync" | "stale" | "unbound";
}
interface Fact {
  id: string;
  value: unknown;
  previous?: unknown;
}
interface StarchartMatch {
  findMatches(text: string, facts: Fact[], options?: { unbound?: boolean }): Match[];
  urlMatches(pattern: string, url: string): boolean;
  originPattern(pattern: string): string | null;
  displayValue(value: unknown): string | null;
}

let M: StarchartMatch;

beforeAll(async () => {
  await import(new URL("../../../xray/src-shared/match.js", import.meta.url).href);
  M = (globalThis as unknown as { StarchartMatch: StarchartMatch }).StarchartMatch;
});

const facts: Fact[] = [
  { id: "addon:pro.price.usd", value: "5.99", previous: "4.99" },
  { id: "addon:pro.name", value: "Pro+", previous: "Pro" },
  { id: "addon:plus.price.usd", value: "14.99" },
  { id: "app.tagline", value: "Every dependency. Code to cosmos." },
];

const slice = (text: string, m: Match) => text.slice(m.start, m.end);

describe("findMatches", () => {
  it("finds current and stale values", () => {
    const text = "Pro+ is $5.99/mo (was $4.99)";
    const ms = M.findMatches(text, facts);
    expect(ms.map((m) => [slice(text, m), m.factId, m.status])).toEqual([
      ["Pro+", "addon:pro.name", "sync"],
      ["$5.99", "addon:pro.price.usd", "sync"],
      ["$4.99", "addon:pro.price.usd", "stale"],
    ]);
  });

  it("respects numeric token boundaries", () => {
    expect(M.findMatches("Plus costs 14.99", facts).map((m) => m.factId)).toEqual(["addon:plus.price.usd"]);
    expect(M.findMatches("value 4.995 here", facts)).toEqual([]);
    expect(M.findMatches("version 1.4.99", facts)).toEqual([]);
    expect(M.findMatches("1,234.99 total", facts)).toEqual([]);
    const end = M.findMatches("It costs 4.99.", facts);
    expect(end).toHaveLength(1);
    expect(end[0]?.status).toBe("stale");
    expect(M.findMatches('"price":"5.99"', facts)[0]?.status).toBe("sync");
  });

  it("respects word boundaries and prefers the longest value", () => {
    expect(M.findMatches("Protect your data", facts)).toEqual([]);
    const text = "Upgrade to Pro today";
    expect(M.findMatches(text, facts).map((m) => [slice(text, m), m.status])).toEqual([["Pro", "stale"]]);
    // "Pro+" claims the span before the stale "Pro" can
    const plus = M.findMatches("Get Pro+ now", facts);
    expect(plus).toHaveLength(1);
    expect(plus[0]?.status).toBe("sync");
  });

  it("matches multi-word values across whitespace variants", () => {
    const text = "Every dependency. Code to\n cosmos.";
    const ms = M.findMatches(text, facts);
    expect(ms).toHaveLength(1);
    expect(ms[0]?.factId).toBe("app.tagline");
    expect(ms[0]?.end).toBe(text.length);
  });

  it("treats a value that is current anywhere as in sync", () => {
    const shared: Fact[] = [
      { id: "a.price", value: "9.99", previous: "7.99" },
      { id: "b.price", value: "7.99" },
    ];
    expect(M.findMatches("7.99", shared)).toEqual([{ start: 0, end: 4, factId: "b.price", status: "sync" }]);
  });

  it("reports unbound currency amounts only when asked, never over a fact match", () => {
    const text = "Pro+ $5.99, Team $29.00, Enterprise €1.299,00 or 12 USD";
    expect(M.findMatches(text, facts).every((m) => m.status !== "unbound")).toBe(true);
    const ms = M.findMatches(text, facts, { unbound: true });
    const unbound = ms.filter((m) => m.status === "unbound").map((m) => slice(text, m));
    expect(unbound).toEqual(["$29.00", "€1.299,00", "12 USD"]);
    expect(ms.find((m) => slice(text, m) === "$5.99")?.status).toBe("sync");
  });

  it("ignores values too short or non-scalar to match reliably", () => {
    const odd: Fact[] = [
      { id: "x", value: "a" },
      { id: "y", value: { nested: true } },
      { id: "z", value: "" },
    ];
    expect(M.findMatches("a b c", odd)).toEqual([]);
    expect(M.displayValue(5)).toBe("5");
    expect(M.displayValue(" Pro ")).toBe("Pro");
    expect(M.displayValue(null)).toBeNull();
  });

  it("returns non-overlapping matches sorted by position", () => {
    const text = "4.99 5.99 4.99 14.99";
    const ms = M.findMatches(text, facts);
    expect(ms.map((m) => m.start)).toEqual([0, 5, 10, 15]);
  });
});

describe("urlMatches / originPattern", () => {
  it("matches plain URLs by prefix and wildcard patterns", () => {
    expect(M.urlMatches("https://example.com/pricing", "https://example.com/pricing/")).toBe(true);
    expect(M.urlMatches("https://example.com/pricing", "https://example.com/pricing?ref=x#top")).toBe(true);
    expect(M.urlMatches("https://example.com/pricing", "https://example.com/pricing/team")).toBe(true);
    expect(M.urlMatches("https://example.com/pricing", "https://example.com/pricingx")).toBe(false);
    expect(M.urlMatches("https://apps.apple.com/*", "https://apps.apple.com/us/app/x/id1")).toBe(true);
    expect(M.urlMatches("https://apps.apple.com/*", "https://evil.test/https://apps.apple.com/")).toBe(false);
  });

  it("derives host permission patterns", () => {
    expect(M.originPattern("https://example.com:8443/pricing")).toBe("https://example.com/*");
    expect(M.originPattern("https://apps.apple.com/*")).toBe("https://apps.apple.com/*");
    expect(M.originPattern("https://*.example.com/*")).toBe("https://*.example.com/*");
    expect(M.originPattern("ftp://example.com")).toBeNull();
  });
});
