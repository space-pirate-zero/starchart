import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ingestCode } from "../code/index.js";
import { Graph } from "../core/graph.js";
import { applyDiscovered, discoverEdges, isDistinctiveValue, nameResembles, type DiscoveredEdge } from "./discover.js";
import { leafFacts, LiteralMatcher, relatedFacts, searchText } from "./literals.js";
import { scanLiterals, type LiteralOccurrence } from "./scan.js";

const FIXTURE = fileURLToPath(new URL("../code/__fixtures__/universe", import.meta.url));

/** Fact + world layers for the fixture universe. */
function addUniverse(g: Graph): Graph {
  g.addNode({ id: "addon:pro", kind: "entity" });
  const facts: [string, unknown][] = [
    ["addon:pro.name", "Nebula Pro"],
    ["addon:pro.price", { usd: 4.99, eur: 5.49 }],
    ["addon:pro.price.usd", 4.99],
    ["addon:pro.price.eur", 5.49],
    ["addon:pro.productId", "pro_monthly"],
    ["addon:pro.features", ["themes", "sync"]],
    ["addon:pro.billing", "monthly"],
    ["addon:pro.status", "active"],
    ["addon:pro.seats", 5],
  ];
  for (const [id, value] of facts) g.addNode({ id, kind: "fact", value });
  for (const [id] of facts) {
    const parent = id.startsWith("addon:pro.price.") ? "addon:pro.price" : "addon:pro";
    g.addEdge({ from: id, to: parent, type: "partOf", origin: "declared" });
  }
  g.addNode({ id: "web:pricing-page", kind: "artifact", binding: { adapter: "fs", path: "web/app/pricing/page.tsx" } });
  g.addEdge({ from: "web:pricing-page", to: "addon:pro.price.usd", type: "embeds", origin: "declared" });
  g.addNode({ id: "web:messages-en", kind: "artifact", binding: { adapter: "fs", path: "./web/messages/en.json" } });
  g.addNode({ id: "web:readme", kind: "artifact", binding: { adapter: "fs", path: "web/README.md" } });
  g.addEdge({ from: "web:readme", to: "addon:pro.price", type: "embeds", origin: "declared" });
  return g;
}

describe("literal matching", () => {
  it("matches whole tokens only", () => {
    const m = new LiteralMatcher(["4.99", "pro_monthly", "Nebula Pro"]);
    const hits = (text: string) => [...m.matches(text)].map((h) => h.needle);
    expect(hits("$4.99 / €4.99 / £4.99")).toEqual(["4.99", "4.99", "4.99"]);
    expect(hits("14.99 4.995 1.4.99 4.99.1 v4.99")).toEqual([]);
    expect(hits("costs 4.99.")).toEqual(["4.99"]);
    expect(hits("'pro_monthly' pro_monthly_v2 xpro_monthly pro_monthly.")).toEqual(["pro_monthly", "pro_monthly"]);
    expect(hits("Get Nebula Pro now, Nebula Professional")).toEqual(["Nebula Pro"]);
    expect(LiteralMatcher.containsToken("price_4.99", "4.99")).toBe(false);
    expect(LiteralMatcher.containsToken("price: 4.99", "4.99")).toBe(true);
  });

  it("only searches distinctive leaf facts", () => {
    const g = addUniverse(new Graph());
    const leaves = leafFacts(g).map((f) => f.id);
    expect(leaves).not.toContain("addon:pro.price");
    expect(leaves).toContain("addon:pro.price.usd");
    const text = (id: string) => searchText(g.node(id)!);
    expect(text("addon:pro.price.usd")).toBe("4.99");
    expect(text("addon:pro.name")).toBe("Nebula Pro");
    expect(text("addon:pro.billing")).toBeUndefined();
    expect(text("addon:pro.status")).toBeUndefined();
    expect(text("addon:pro.seats")).toBeUndefined();
    expect(text("addon:pro.features")).toBeUndefined();
    expect([...relatedFacts(g, "addon:pro.price.usd")].sort()).toEqual(["addon:pro.price", "addon:pro.price.usd"]);
    expect([...relatedFacts(g, "addon:pro.price")].sort()).toEqual(["addon:pro.price", "addon:pro.price.eur", "addon:pro.price.usd"]);
  });
});

describe("scanLiterals", () => {
  let graph: Graph;
  let occ: LiteralOccurrence[];
  const find = (file: string, factId: string) => occ.filter((o) => o.file === file && o.factId === factId);

  beforeAll(async () => {
    graph = addUniverse(await ingestCode(FIXTURE, { scopes: { web: "web", ios: "ios", android: "android", api: "api" }, exclude: [] }));
    occ = await scanLiterals(FIXTURE, graph);
  });

  it("reports positions and trimmed line text", () => {
    const [first] = find("web/lib/pricing.ts", "addon:pro.price.usd");
    expect(first).toEqual({
      factId: "addon:pro.price.usd",
      value: "4.99",
      file: "web/lib/pricing.ts",
      line: 5,
      column: 30,
      text: "export const PRO_PRICE_USD = 4.99;",
      bound: true,
    });
  });

  it("treats files with an anchoring symbol, bound artifacts and generated files as bound", () => {
    // PRO_PRICE_USD anchors the fact: every occurrence in that file is covered
    expect(find("web/lib/pricing.ts", "addon:pro.price.usd").every((o) => o.bound)).toBe(true);
    // the pricing page artifact embeds the fact
    expect(find("web/app/pricing/page.tsx", "addon:pro.price.usd")).toEqual([]);
    // codegen output
    expect(find("web/lib/generated-facts.ts", "addon:pro.productId").map((o) => o.bound)).toEqual([true]);
    // README artifact embeds the container fact addon:pro.price, which covers price.usd
    expect(find("web/README.md", "addon:pro.price.usd").map((o) => o.bound)).toEqual([true]);
    // ProductID.proMonthly anchors addon:pro.productId via annotation
    expect(find("ios/Sources/Core/ProductID.swift", "addon:pro.productId").map((o) => o.bound)).toEqual([true]);
  });

  it("flags unbound occurrences in code and content", () => {
    expect(find("web/messages/en.json", "addon:pro.price.usd").map((o) => [o.line, o.bound])).toEqual([[4, false]]);
    expect(find("web/messages/de.json", "addon:pro.price.usd").map((o) => o.bound)).toEqual([false]);
    expect(find("web/messages/en.json", "addon:pro.name").length).toBe(2);
    expect(find("ios/Sources/Core/Pricing.swift", "addon:pro.price.usd").map((o) => [o.line, o.bound])).toEqual([
      [4, false],
      [6, false],
    ]);
    expect(find("android/app/src/main/java/com/nebula/Pricing.kt", "addon:pro.productId").map((o) => o.bound)).toEqual([false]);
    expect(find("ios/Sources/Core/Pricing+EUR.swift", "addon:pro.price.eur").map((o) => o.bound)).toEqual([false]);
  });

  it("never scans lockfiles, excluded globs or generic values", async () => {
    expect(occ.some((o) => o.file.endsWith("Package.resolved"))).toBe(false);
    expect(occ.some((o) => o.factId === "addon:pro.billing" || o.factId === "addon:pro.status")).toBe(false);
    const limited = await scanLiterals(FIXTURE, graph, { roots: ["web"], exclude: ["messages/**"] });
    expect(limited.every((o) => o.file.startsWith("web/") && !o.file.startsWith("web/messages/"))).toBe(true);
    expect(limited.length).toBeGreaterThan(0);
  });

  it("returns occurrences sorted by file, line and column", () => {
    for (let i = 1; i < occ.length; i++) {
      const a = occ[i - 1]!;
      const b = occ[i]!;
      const order = a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
      expect(order, `${a.file}:${a.line} before ${b.file}:${b.line}`).toBeLessThanOrEqual(0);
    }
  });

  describe("discoverEdges", () => {
    let edges: DiscoveredEdge[];
    const get = (from: string, type: string, to: string) => edges.find((e) => e.from === from && e.type === type && e.to === to);

    beforeAll(() => {
      edges = discoverEdges(graph, occ);
    });

    it("proposes anchors from symbols whose literal equals a fact value", () => {
      expect(get("symbol:ios/Pricing.proUSD", "anchors", "addon:pro.price.usd")).toMatchObject({ confidence: 0.9, origin: "discovered" });
      expect(get("symbol:android/Pricing.PRO_USD", "anchors", "addon:pro.price.usd")?.confidence).toBe(0.9);
      expect(get("symbol:api/internal/pricing.ProUSD", "anchors", "addon:pro.price.usd")?.confidence).toBe(0.9);
      expect(get("symbol:ios/Pricing.proEUR", "anchors", "addon:pro.price.eur")?.confidence).toBe(0.9);
      expect(get("symbol:ios/Entitlements.proFeatures", "anchors", "addon:pro.features")?.confidence).toBe(0.9);
      expect(get("symbol:android/Tier.PRO", "anchors", "addon:pro.productId")?.confidence).toBe(0.9);
      expect(get("symbol:api/internal/pricing.ProMonthly", "anchors", "addon:pro.productId")?.reason).toMatch(/equals addon:pro.productId and the names match/);
    });

    it("skips edges the graph already has", () => {
      expect(get("symbol:web/lib/pricing#PRO_PRICE_USD", "anchors", "addon:pro.price.usd")).toBeUndefined();
      expect(get("symbol:ios/ProductID.proMonthly", "anchors", "addon:pro.productId")).toBeUndefined();
    });

    it("proposes embeds for unbound literals inside fs-bound artifacts", () => {
      expect(get("web:messages-en", "embeds", "addon:pro.price.usd")).toMatchObject({ confidence: 0.7, reason: '"4.99" appears unbound at web/messages/en.json:4' });
      expect(get("web:messages-en", "embeds", "addon:pro.name")?.confidence).toBe(0.7);
      // the README artifact already embeds the price (via its container), but not the name it mentions
      expect(get("web:readme", "embeds", "addon:pro.price.usd")).toBeUndefined();
      expect(get("web:readme", "embeds", "addon:pro.name")?.reason).toBe('"Nebula Pro" appears unbound at web/README.md:4');
    });

    it("proposes anchors from localized strings that contain fact values", () => {
      expect(get("i18n:web/pricing.cta", "anchors", "addon:pro.price.usd")).toMatchObject({ confidence: 0.6 });
      expect(get("i18n:web/pricing.cta", "anchors", "addon:pro.name")?.confidence).toBe(0.6);
      expect(get("i18n:ios/paywall.title", "anchors", "addon:pro.name")?.confidence).toBe(0.6);
    });

    it("applies only confident edges", () => {
      const copy = Graph.from(graph.toJSON());
      const added = applyDiscovered(copy, edges);
      expect(added.length).toBeGreaterThan(0);
      expect(added.every((e) => (e.confidence ?? 0) >= 0.8 && e.origin === "discovered" && typeof e.meta?.reason === "string")).toBe(true);
      expect(copy.outgoing("symbol:ios/Pricing.proUSD", "anchors").map((e) => e.to)).toEqual(["addon:pro.price.usd"]);
      expect(copy.outgoing("web:messages-en", "embeds")).toEqual([]);
      expect(applyDiscovered(copy, edges)).toEqual([]);
      expect(applyDiscovered(copy, edges, 0.5).length).toBeGreaterThan(0);
    });
  });
});

describe("discovery heuristics", () => {
  it("judges distinctiveness and name resemblance", () => {
    expect(isDistinctiveValue("pro_monthly")).toBe(true);
    expect(isDistinctiveValue("pro")).toBe(false);
    expect(isDistinctiveValue("monthly")).toBe(false);
    expect(isDistinctiveValue(4.99)).toBe(true);
    expect(isDistinctiveValue(5)).toBe(false);
    expect(isDistinctiveValue(["a", "b"])).toBe(true);
    expect(isDistinctiveValue(["a"])).toBe(false);
    const sym = { id: "symbol:ios/ProductID.proMonthly", kind: "symbol" as const, layer: "code" as const, label: "proMonthly", meta: { qname: "ProductID.proMonthly" } };
    expect(nameResembles(sym, { id: "addon:pro.productId", kind: "fact", layer: "fact" })).toBe(true);
    expect(nameResembles(sym, { id: "addon:team.seats", kind: "fact", layer: "fact" })).toBe(false);
  });

  it("lowers confidence when several facts share a value", () => {
    const g = new Graph();
    g.addNode({ id: "a:x", kind: "entity" });
    g.addNode({ id: "a:x.price.usd", kind: "fact", value: 4.99 });
    g.addNode({ id: "a:x.price.eur", kind: "fact", value: 4.99 });
    g.addNode({ id: "symbol:app/foo#cost", kind: "symbol", value: 4.99, label: "cost" });
    g.addNode({ id: "symbol:app/foo#usdPrice", kind: "symbol", value: 4.99, label: "usdPrice" });
    const edges = discoverEdges(g);
    const conf = (from: string, to: string) => edges.find((e) => e.from === from && e.to === to)?.confidence;
    expect(conf("symbol:app/foo#cost", "a:x.price.usd")).toBe(0.4);
    // "usdPrice" shares both "usd" and "price" with price.usd but only "price" with price.eur: both resemble
    expect(conf("symbol:app/foo#usdPrice", "a:x.price.usd")).toBe(0.75);
  });
});
