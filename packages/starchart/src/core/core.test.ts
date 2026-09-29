import { describe, expect, it } from "vitest";
import { Graph } from "./graph.js";
import { computeImpact, explainPath } from "./impact.js";
import { buildLock, changedSince, dependencies, staleArtifacts } from "./lock.js";
import { orderSteps } from "./order.js";

/** The Pro add-on universe in miniature: code -> facts -> world. */
function universe(): Graph {
  const g = new Graph();
  g.addNode({ id: "addon:pro", kind: "entity", status: "active" });
  g.addNode({ id: "addon:pro.price", kind: "fact", value: { usd: 4.99 } });
  g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 4.99 });
  g.addNode({ id: "addon:pro.name", kind: "fact", value: "Pro" });
  g.addEdge({ from: "addon:pro.price.usd", to: "addon:pro.price", type: "partOf" });
  g.addEdge({ from: "addon:pro.price", to: "addon:pro", type: "partOf" });
  g.addEdge({ from: "addon:pro.name", to: "addon:pro", type: "partOf" });

  g.addNode({ id: "file:ios/PaywallView.swift", kind: "file", hash: "f1" });
  g.addNode({ id: "symbol:ios/PaywallView", kind: "symbol", hash: "s1" });
  g.addNode({ id: "screen:ios/Paywall", kind: "screen", hash: "sc1" });
  g.addNode({ id: "symbol:ios/Pricing.proUSD", kind: "symbol", hash: "p1", value: 4.99 });
  g.addEdge({ from: "file:ios/PaywallView.swift", to: "symbol:ios/PaywallView", type: "contains" });
  g.addEdge({ from: "screen:ios/Paywall", to: "symbol:ios/PaywallView", type: "references" });
  g.addEdge({ from: "symbol:ios/PaywallView", to: "symbol:ios/Pricing.proUSD", type: "references" });
  g.addEdge({ from: "symbol:ios/Pricing.proUSD", to: "addon:pro.price.usd", type: "anchors" });
  g.addNode({ id: "test:ios/PaywallTests.swift", kind: "test", hash: "t1" });
  g.addEdge({ from: "test:ios/PaywallTests.swift", to: "screen:ios/Paywall", type: "tests" });

  g.addNode({ id: "web:pricing", kind: "artifact", binding: { adapter: "fs", path: "web/pricing.tsx" } });
  g.addNode({ id: "stripe:price/pro", kind: "artifact", binding: { adapter: "stripe", price: "price_1" } });
  g.addNode({ id: "appstore:shot/03", kind: "artifact", types: ["schema:ImageObject"], binding: { adapter: "appstore" } });
  g.addNode({ id: "reel:spring", kind: "artifact", types: ["schema:VideoObject"], validThrough: "2026-06-30" });
  g.addNode({ id: "web:landing", kind: "artifact", binding: { adapter: "fs", path: "web/landing.tsx" } });
  g.addNode({ id: "web:og", kind: "artifact", binding: { adapter: "fs", path: "og.png" } });
  g.addEdge({ from: "web:pricing", to: "addon:pro.price.usd", type: "embeds" });
  g.addEdge({ from: "stripe:price/pro", to: "addon:pro.price", type: "mirrors" });
  g.addEdge({ from: "appstore:shot/03", to: "screen:ios/Paywall", type: "captures" });
  g.addEdge({ from: "reel:spring", to: "addon:pro", type: "promotes" });
  g.addEdge({ from: "web:landing", to: "addon:pro", type: "describes" });
  g.addEdge({ from: "web:og", to: "addon:pro.price.usd", type: "renders" });
  g.addEdge({ from: "web:pricing", to: "stripe:price/pro", type: "after" });
  return g;
}

const now = new Date("2026-09-29T00:00:00Z");

describe("computeImpact", () => {
  it("propagates a fact change across all three layers with classes", () => {
    const g = universe();
    const { items } = computeImpact(g, ["addon:pro.price.usd"], { now });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));

    expect(byId["web:pricing"]?.class).toBe("auto");
    expect(byId["web:og"]?.class).toBe("auto");
    expect(byId["stripe:price/pro"]?.class).toBe("manual"); // stripe is read-only by default
    expect(byId["web:landing"]?.class).toBe("review");
    expect(byId["reel:spring"]?.class).toBe("retire"); // expired
    // fact -> anchored constant -> screen -> screenshot
    expect(byId["symbol:ios/Pricing.proUSD"]?.class).toBe("code");
    expect(byId["screen:ios/Paywall"]?.class).toBe("info");
    expect(byId["appstore:shot/03"]?.class).toBe("manual");
    expect(byId["test:ios/PaywallTests.swift"]?.class).toBe("test");
  });

  it("propagates a code change out to the world and explains why", () => {
    const g = universe();
    const { items } = computeImpact(g, ["symbol:ios/PaywallView"], { now });
    const shot = items.find((i) => i.id === "appstore:shot/03");
    expect(shot?.class).toBe("manual");
    expect(explainPath(shot!.path)).toBe(
      "symbol:ios/PaywallView --references--> screen:ios/Paywall --captures--> appstore:shot/03",
    );
    // a layout change does not touch the price fact or its embedders
    expect(items.find((i) => i.id === "web:pricing")).toBeUndefined();
  });

  it("hides intermediate code nodes in surface mode but still traverses them", () => {
    const g = universe();
    const { items } = computeImpact(g, ["symbol:ios/Pricing.proUSD"], { now });
    expect(items.map((i) => i.id)).not.toContain("symbol:ios/PaywallView");
    expect(items.map((i) => i.id)).toContain("screen:ios/Paywall");
    expect(items.map((i) => i.id)).toContain("web:pricing"); // via anchors -> fact
  });

  it("respects canWrite and retirement", () => {
    const g = universe();
    g.addNode({ id: "addon:pro", kind: "entity", status: "retired" });
    g.addNode({ id: "reel:spring", kind: "artifact", validThrough: "2027-01-01" });
    const { items } = computeImpact(g, ["addon:pro"], { now, canWrite: (a) => a === "fs" || a === "stripe" });
    expect(items.find((i) => i.id === "reel:spring")?.class).toBe("retire");
  });

  it("drops low-confidence paths", () => {
    const g = universe();
    g.addEdge({ from: "web:landing", to: "addon:pro.name", type: "embeds", confidence: 0.2 });
    const { items } = computeImpact(g, ["addon:pro.name"], { now, minConfidence: 0.3 });
    // still reached through partOf -> entity -> describes at full confidence
    expect(items.find((i) => i.id === "web:landing")?.via).toBe("describes");
  });
});

describe("orderSteps", () => {
  it("runs money systems first and honors after edges", () => {
    const g = universe();
    const { items } = computeImpact(g, ["addon:pro.price.usd"], { now });
    const { steps, cycles } = orderSteps(g, items.filter((i) => i.node.layer === "world"));
    const ids = steps.map((s) => s.item.id);
    expect(cycles).toEqual([]);
    expect(ids.indexOf("stripe:price/pro")).toBeLessThan(ids.indexOf("web:pricing"));
    expect(steps.find((s) => s.item.id === "web:pricing")?.waitsFor).toEqual(["stripe:price/pro"]);
  });
});

describe("lock", () => {
  it("detects stale artifacts after a fact or code change", () => {
    const g = universe();
    const lock = buildLock(g);
    expect(staleArtifacts(g, lock)).toEqual([]);
    expect(dependencies(g, "appstore:shot/03")).toContain("symbol:ios/PaywallView");

    g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 5.99 });
    g.addNode({ id: "symbol:ios/PaywallView", kind: "symbol", hash: "s2" });
    const stale = staleArtifacts(g, lock).map((s) => s.id);
    expect(stale).toContain("web:pricing");
    expect(stale).toContain("appstore:shot/03");
    expect(stale).toContain("web:landing"); // describes the entity, so any fact change asks for review

    const changed = changedSince(g, lock).map((c) => c.id);
    expect(changed).toEqual(expect.arrayContaining(["addon:pro.price.usd", "symbol:ios/PaywallView"]));

    const relocked = buildLock(g, lock, ["web:pricing"]);
    const after = staleArtifacts(g, relocked).map((s) => s.id);
    expect(after).not.toContain("web:pricing");
    expect(after).toContain("appstore:shot/03");
  });
});
