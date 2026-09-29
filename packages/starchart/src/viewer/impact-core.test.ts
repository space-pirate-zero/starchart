import { beforeAll, describe, expect, it } from "vitest";
import { Graph } from "../core/graph.js";
import { computeImpact, type ImpactOptions } from "../core/impact.js";
import type { GraphNode } from "../core/model.js";
import { impactConfig, probeDecay, unwritableArtifacts, writableAdapters, type ImpactConfig } from "./impact-config.js";
import { canWrite as registryCanWrite } from "../adapters/registry.js";

interface BrowserImpactItem {
  id: string;
  depth: number;
  confidence: number;
  via: string;
  path: { from: string; to: string; type: string }[];
  class: string;
  reason: string;
}

interface BrowserImpact {
  createIndex(graph: unknown): unknown;
  computeImpact(
    index: unknown,
    seeds: string[],
    cfg: ImpactConfig,
    options?: { now?: Date | number; includeCode?: "surface" | "all" | "none" },
  ): { seeds: string[]; items: BrowserImpactItem[] };
  explainPath(path: BrowserImpactItem["path"]): string;
}

let Impact: BrowserImpact;

beforeAll(async () => {
  await import(new URL("./assets/impact-core.js", import.meta.url).href);
  Impact = (globalThis as unknown as { StarchartImpact: BrowserImpact }).StarchartImpact;
});

/** A universe touching every propagation direction, decay, contains, media, retirement and expiry. */
function universe(): Graph {
  const g = new Graph();
  g.addNode({ id: "addon:pro", kind: "entity", status: "active" });
  g.addNode({ id: "addon:pro.price", kind: "fact", value: { usd: 4.99 } });
  g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 4.99 });
  g.addNode({ id: "addon:pro.name", kind: "fact", value: "Pro" });
  g.addEdge({ from: "addon:pro.price.usd", to: "addon:pro.price", type: "partOf" });
  g.addEdge({ from: "addon:pro.price", to: "addon:pro", type: "partOf" });
  g.addEdge({ from: "addon:pro.name", to: "addon:pro", type: "partOf" });
  g.addNode({ id: "campaign:old", kind: "entity", status: "retired" });
  g.addNode({ id: "campaign:old.headline", kind: "fact", value: "Spring sale" });
  g.addEdge({ from: "campaign:old.headline", to: "campaign:old", type: "partOf" });

  g.addNode({ id: "file:ios/PaywallView.swift", kind: "file", hash: "f1" });
  g.addNode({ id: "file:ios/App.swift", kind: "file", hash: "f2" });
  g.addNode({ id: "symbol:ios/PaywallView", kind: "symbol", hash: "s1" });
  g.addNode({ id: "screen:ios/Paywall", kind: "screen", hash: "sc1" });
  g.addNode({ id: "symbol:ios/Pricing.proUSD", kind: "symbol", hash: "p1", value: 4.99 });
  g.addNode({ id: "symbol:gen/Facts.PRO", kind: "symbol", hash: "g1", meta: { generated: true } });
  g.addNode({ id: "route:web/pricing", kind: "route", hash: "r1" });
  g.addNode({ id: "pkg:npm/stripe", kind: "package" });
  g.addNode({ id: "event:pro_purchased", kind: "event" });
  g.addEdge({ from: "file:ios/PaywallView.swift", to: "symbol:ios/PaywallView", type: "contains" });
  g.addEdge({ from: "file:ios/App.swift", to: "file:ios/PaywallView.swift", type: "imports" });
  g.addEdge({ from: "screen:ios/Paywall", to: "symbol:ios/PaywallView", type: "references" });
  g.addEdge({ from: "symbol:ios/PaywallView", to: "symbol:ios/Pricing.proUSD", type: "references" });
  g.addEdge({ from: "symbol:ios/Pricing.proUSD", to: "addon:pro.price.usd", type: "anchors" });
  g.addEdge({ from: "symbol:gen/Facts.PRO", to: "addon:pro.price", type: "anchors" });
  g.addEdge({ from: "route:web/pricing", to: "pkg:npm/stripe", type: "dependsOn", confidence: 0.9 });
  g.addEdge({ from: "route:web/pricing", to: "addon:pro.price.usd", type: "displays" });
  g.addEdge({ from: "symbol:ios/PaywallView", to: "event:pro_purchased", type: "emits" });
  g.addNode({ id: "test:ios/PaywallTests.swift", kind: "test", hash: "t1" });
  g.addEdge({ from: "test:ios/PaywallTests.swift", to: "screen:ios/Paywall", type: "tests" });

  g.addNode({ id: "web:pricing", kind: "artifact", binding: { adapter: "fs", path: "web/pricing.tsx" } });
  g.addNode({ id: "web:pricing-page", kind: "artifact", binding: { adapter: "url", url: "https://x.test/pricing" } });
  g.addNode({ id: "stripe:price/pro", kind: "artifact", binding: { adapter: "stripe", price: "price_1" } });
  g.addNode({ id: "appstore:shot/03", kind: "artifact", types: ["schema:ImageObject"], binding: { adapter: "appstore" } });
  g.addNode({ id: "reel:spring", kind: "artifact", types: ["schema:VideoObject"], validThrough: "2026-06-30" });
  g.addNode({ id: "web:landing", kind: "artifact", binding: { adapter: "fs", path: "web/landing.tsx" } });
  g.addNode({ id: "web:og", kind: "artifact", binding: { adapter: "fs", path: "og.png" } });
  g.addNode({ id: "web:og-copy", kind: "artifact", types: ["schema:ImageObject"], binding: { adapter: "fs", path: "og2.png" } });
  g.addNode({ id: "web:banner", kind: "artifact" });
  g.addNode({ id: "posthog:dash", kind: "artifact", binding: { adapter: "posthog" } });
  g.addEdge({ from: "web:pricing", to: "addon:pro.price.usd", type: "embeds" });
  g.addEdge({ from: "stripe:price/pro", to: "addon:pro.price", type: "mirrors" });
  g.addEdge({ from: "appstore:shot/03", to: "screen:ios/Paywall", type: "captures" });
  g.addEdge({ from: "reel:spring", to: "addon:pro", type: "promotes" });
  g.addEdge({ from: "web:landing", to: "addon:pro", type: "describes" });
  g.addEdge({ from: "web:og", to: "addon:pro.price.usd", type: "renders" });
  g.addEdge({ from: "web:og-copy", to: "web:og", type: "derivedFrom" });
  g.addEdge({ from: "web:og-copy", to: "addon:pro.name", type: "embeds", confidence: 0.6 });
  g.addEdge({ from: "web:banner", to: "campaign:old.headline", type: "embeds" });
  g.addEdge({ from: "route:web/pricing", to: "web:pricing-page", type: "publishes" });
  g.addEdge({ from: "event:pro_purchased", to: "posthog:dash", type: "emits" });
  g.addEdge({ from: "web:pricing", to: "stripe:price/pro", type: "after" });
  return g;
}

const now = new Date("2026-09-29T00:00:00Z");
const canWrite = (adapter: string) => adapter === "fs" || adapter === "url";

function strip(items: BrowserImpactItem[]) {
  return items.map((i) => ({
    id: i.id,
    depth: i.depth,
    confidence: i.confidence,
    via: i.via,
    path: i.path,
    class: i.class,
    reason: i.reason,
  }));
}

function compare(graph: Graph, seeds: string[], includeCode: ImpactOptions["includeCode"] = "surface", maxCodeDepth?: number) {
  const serialized = graph.toJSON();
  // Core traverses the same insertion order as the browser index: both built from the serialized graph.
  const coreGraph = Graph.from(serialized);
  const core = computeImpact(coreGraph, seeds, { now, canWrite, includeCode, maxCodeDepth });
  const cfg = impactConfig(serialized, { writableAdapters: writableAdapters(serialized, canWrite), maxCodeDepth });
  const browser = Impact.computeImpact(Impact.createIndex(serialized), seeds, cfg, { now, includeCode });
  expect(browser.seeds).toEqual(core.seeds);
  expect(strip(browser.items)).toEqual(strip(core.items as unknown as BrowserImpactItem[]));
  return core;
}

describe("in-browser impact port: per-binding writes", () => {
  it("matches core when an adapter vetoes a binding and for external-id anchors", () => {
    const g = new Graph();
    g.addNode({ id: "addon:pro", kind: "entity" });
    g.addNode({ id: "addon:pro.price", kind: "fact", value: 4.99 });
    g.addEdge({ from: "addon:pro.price", to: "addon:pro", type: "partOf" });
    g.addNode({ id: "appstore:iap", kind: "artifact", binding: { adapter: "appstore", app: "1", product: "p" } });
    g.addNode({ id: "appstore:listing", kind: "artifact", binding: { adapter: "appstore", app: "1", field: "description" } });
    g.addNode({ id: "stripe:price", kind: "artifact", binding: { adapter: "stripe", price: "price_1" } });
    g.addNode({ id: "symbol:web/lib#PRICE", kind: "symbol", value: "price_1", hash: "h" });
    g.addEdge({ from: "appstore:iap", to: "addon:pro.price", type: "mirrors" });
    g.addEdge({ from: "appstore:listing", to: "addon:pro.price", type: "embeds" });
    g.addEdge({ from: "stripe:price", to: "addon:pro.price", type: "mirrors" });
    g.addEdge({ from: "symbol:web/lib#PRICE", to: "stripe:price", type: "anchors" });

    const settings = { appstore: { write: true } };
    const nodeCanWrite = (adapter: string, node?: GraphNode) => registryCanWrite(adapter, settings, node);
    const serialized = g.toJSON();
    const core = computeImpact(Graph.from(serialized), ["addon:pro.price"], { now, canWrite: nodeCanWrite });
    const writable = writableAdapters(serialized, (a) => registryCanWrite(a, settings));
    const cfg = impactConfig(serialized, {
      writableAdapters: writable,
      unwritableArtifacts: unwritableArtifacts(serialized, writable, (a, n) => registryCanWrite(a, settings, n)),
    });
    const browser = Impact.computeImpact(Impact.createIndex(serialized), ["addon:pro.price"], cfg, { now });
    expect(strip(browser.items)).toEqual(strip(core.items as unknown as BrowserImpactItem[]));
    const cls = Object.fromEntries(core.items.map((i) => [i.id, i.class]));
    expect(cls).toMatchObject({ "appstore:iap": "manual", "appstore:listing": "auto", "symbol:web/lib#PRICE": "code" });
    expect(core.items.find((i) => i.id === "appstore:iap")?.reason).toBe("appstore cannot update this binding; update it by hand");
  });
});

describe("in-browser impact port", () => {
  it("measures decay tables from the core", () => {
    const { decay, containsConfidence } = probeDecay();
    expect(decay.imports).toBe(0.85);
    expect(decay.dependsOn).toBe(0.7);
    expect(containsConfidence).toBe(0.8);
    expect(decay.anchors).toBeUndefined();
  });

  it("detects media types through the core classifier", () => {
    const cfg = impactConfig(universe().toJSON());
    expect(cfg.mediaTypes).toEqual(["schema:ImageObject", "schema:VideoObject"]);
  });

  const seeds = [
    ["addon:pro.price.usd"],
    ["addon:pro.name"],
    ["addon:pro"],
    ["campaign:old.headline"],
    ["symbol:ios/PaywallView"],
    ["symbol:ios/Pricing.proUSD"],
    ["pkg:npm/stripe"],
    ["route:web/pricing"],
    ["addon:pro.price.usd", "symbol:ios/PaywallView", "missing:node"],
  ];

  for (const s of seeds) {
    it(`matches core computeImpact from ${s.join(" + ")}`, () => {
      const core = compare(universe(), s);
      expect(core.items.length).toBeGreaterThan(0);
    });
  }

  it("matches core with includeCode all and a tight code-depth limit", () => {
    compare(universe(), ["symbol:ios/Pricing.proUSD"], "all", 1);
    compare(universe(), ["pkg:npm/stripe"], "all");
    compare(universe(), ["addon:pro.price.usd"], "none");
  });

  it("explains paths the same way as the core", () => {
    const serialized = universe().toJSON();
    const cfg = impactConfig(serialized, { writableAdapters: ["fs"] });
    const { items } = Impact.computeImpact(Impact.createIndex(serialized), ["symbol:ios/PaywallView"], cfg, { now });
    const shot = items.find((i) => i.id === "appstore:shot/03");
    expect(shot && Impact.explainPath(shot.path)).toBe(
      "symbol:ios/PaywallView --references--> screen:ios/Paywall --captures--> appstore:shot/03",
    );
  });
});
