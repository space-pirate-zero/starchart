import { describe, expect, it } from "vitest";
import { Graph } from "../core/graph.js";
import { buildLock, emptyLock } from "../core/lock.js";
import { changeCost, DEFAULT_HOURS } from "./cost.js";
import { findOrphans } from "./orphans.js";
import { badgeJson, badgeSvg, realityScore } from "./score.js";

const NOW = new Date("2026-09-29T12:00:00Z");

describe("findOrphans", () => {
  function graph(): Graph {
    const g = new Graph();
    g.addNode({ id: "addon:pro", kind: "entity" });
    g.addNode({ id: "addon:pro.price", kind: "fact", value: 4.99 });
    g.addNode({ id: "addon:pro.legacyCode", kind: "fact", value: "PRO1" });
    g.addEdge({ from: "addon:pro.price", to: "addon:pro", type: "partOf" });
    g.addEdge({ from: "addon:pro.legacyCode", to: "addon:pro", type: "partOf" });

    g.addNode({ id: "stripe:price/pro", kind: "artifact", binding: { adapter: "stripe", price: "price_pro" } });
    g.addEdge({ from: "stripe:price/pro", to: "addon:pro.price", type: "mirrors" });
    g.addNode({ id: "cdn:banner-2024", kind: "artifact", binding: { adapter: "fs", path: "banner.png" } });
    g.addNode({ id: "reel:spring", kind: "artifact", validThrough: "2026-06-30" });
    g.addEdge({ from: "reel:spring", to: "addon:pro.price", type: "embeds" });

    g.addNode({ id: "flag:new-paywall", kind: "flag", meta: { rollout: 100 } });
    g.addNode({ id: "flag:beta", kind: "flag", meta: { rollout: 20 } });
    g.addNode({ id: "env:LEGACY_KEY", kind: "env", meta: { declaredOnly: true } });
    g.addNode({ id: "env:API_URL", kind: "env", meta: { declaredOnly: true } });
    g.addNode({ id: "file:web/api.ts", kind: "file" });
    g.addEdge({ from: "file:web/api.ts", to: "env:API_URL", type: "readsEnv" });

    g.addNode({ id: "pkg:npm/zod", kind: "package" });
    g.addNode({ id: "pkg:npm/left-pad", kind: "package" });
    g.addNode({ id: "pkg:npm/deep-dep", kind: "package", meta: { transitive: true } });
    g.addNode({ id: "pkg:swift/sentry-cocoa", kind: "package" });
    g.addEdge({ from: "file:web/api.ts", to: "pkg:npm/zod", type: "dependsOn" });

    g.addNode({ id: "event:paywall_viewed", kind: "event" });
    g.addNode({ id: "event:old_click", kind: "event" });
    g.addNode({ id: "posthog:funnel/paywall", kind: "artifact", binding: { adapter: "posthog" } });
    g.addEdge({ from: "posthog:funnel/paywall", to: "event:paywall_viewed", type: "references" });

    g.addNode({ id: "symbol:web/checkout.PRICE", kind: "symbol", value: "price_in_code" });
    return g;
  }

  it("finds every orphan kind", () => {
    const listed = {
      stripe: [
        { externalId: "price_pro", label: "Pro monthly", binding: { adapter: "stripe", price: "price_pro" }, active: true },
        { externalId: "price_old", label: "Pro 2023", binding: { adapter: "stripe", price: "price_old" }, active: true },
        { externalId: "price_archived", label: "Archived", binding: { adapter: "stripe", price: "price_archived" }, active: false },
        { externalId: "price_in_code", label: "Checkout", binding: { adapter: "stripe", price: "price_in_code" }, active: true },
      ],
    };
    const orphans = findOrphans(graph(), listed, { now: NOW });
    expect(orphans.map((o) => `${o.kind} ${o.id}: ${o.message}`)).toEqual([
      "expired reel:spring: reel:spring expired on 2026-06-30 but is not retired",
      "external-unreferenced stripe:price_old: stripe Pro 2023 (price_old) is active but no artifact or code references it",
      "artifact-unlinked cdn:banner-2024: cdn:banner-2024 does not embed, render, mirror or describe anything",
      "fact-unused addon:pro.legacyCode: addon:pro.legacyCode is not used by any code or artifact",
      "package-unused pkg:npm/left-pad: pkg:npm/left-pad is a dependency but no file uses it",
      "env-unused env:LEGACY_KEY: env:LEGACY_KEY is declared but nothing reads it",
      "flag-unused flag:new-paywall: flag:new-paywall is rolled out to 100%; remove the flag and its dead branch",
      "event-unconsumed event:old_click: event:old_click is emitted but no dashboard, funnel or artifact consumes it",
    ]);
  });

  it("stays quiet about events and packages the code layer does not link", () => {
    const g = new Graph();
    g.addNode({ id: "event:a", kind: "event" });
    g.addNode({ id: "pkg:swift/sentry-cocoa", kind: "package" });
    expect(findOrphans(g, {}, { now: NOW })).toEqual([]);
  });
});

describe("realityScore", () => {
  function graph(): Graph {
    const g = new Graph();
    g.addNode({ id: "addon:pro.price", kind: "fact", value: 4.99 });
    for (const id of ["web:pricing", "stripe:price/pro", "appstore:iap/pro", "web:landing"]) {
      g.addNode({ id, kind: "artifact", binding: { adapter: id.split(":")[0]! } });
      g.addEdge({ from: id, to: "addon:pro.price", type: "embeds" });
    }
    g.addNode({ id: "reel:spring", kind: "artifact", validThrough: "2026-06-30", binding: { adapter: "fs" } });
    g.addNode({ id: "print:flyer", kind: "artifact" });
    g.addNode({ id: "reel:2024", kind: "artifact", status: "retired" });
    return g;
  }

  it("scores bound, fresh, in-sync artifacts", () => {
    const g = graph();
    const lock = buildLock(g, emptyLock(), ["web:pricing", "stripe:price/pro", "appstore:iap/pro", "reel:spring", "print:flyer"]);
    const report = realityScore(g, lock, {
      now: NOW,
      auditDiffs: [{ artifact: "appstore:iap/pro", kind: "stale", message: "price is 3.99" }],
    });
    expect(report).toEqual({
      score: 33,
      total: 6,
      inSync: 2,
      breakdown: {
        unbound: ["print:flyer"],
        stale: ["web:landing"],
        expired: ["reel:spring"],
        failingAudit: ["appstore:iap/pro"],
      },
    });
    g.addNode({ id: "addon:pro.price", kind: "fact", value: 5.99 });
    expect(realityScore(g, lock, { now: NOW }).breakdown.stale).toEqual(["appstore:iap/pro", "stripe:price/pro", "web:landing", "web:pricing"]);
  });

  it("is 100 for an empty world", () => {
    expect(realityScore(new Graph(), emptyLock()).score).toBe(100);
  });

  it("renders a valid shields-style badge", () => {
    const svg = badgeSvg(97);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain("<title>reality: 97%</title>");
    expect(svg).toContain('fill="#00ff41"');
    expect(svg).toContain('fill="#0b0b0b"');
    expect(badgeSvg(85)).toContain('fill="#ffd000"');
    expect(badgeSvg(12)).toContain('fill="#ff1493"');
    expect(badgeSvg(140)).toContain(">100%</text>");
    // well-formed: every opened element is closed in order
    const stack: string[] = [];
    for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
      if (m[3]) continue;
      if (m[1]) expect(stack.pop()).toBe(m[2]);
      else stack.push(m[2]!);
    }
    expect(stack).toEqual([]);
    const width = Number(/<svg[^>]* width="(\d+)"/.exec(svg)![1]);
    expect(width).toBeGreaterThan(60);
    expect(width).toBeLessThan(120);
  });

  it("emits shields endpoint JSON", () => {
    expect(badgeJson(97.4)).toEqual({ schemaVersion: 1, label: "reality", message: "97%", color: "#00ff41" });
    expect(badgeJson(50).color).toBe("#ff1493");
  });
});

describe("changeCost", () => {
  function graph(): Graph {
    const g = new Graph();
    g.addNode({ id: "addon:pro", kind: "entity" });
    g.addNode({ id: "addon:pro.price", kind: "fact", value: 4.99 });
    g.addNode({ id: "addon:pro.name", kind: "fact", value: "Pro" });
    g.addEdge({ from: "addon:pro.price", to: "addon:pro", type: "partOf" });
    g.addEdge({ from: "addon:pro.name", to: "addon:pro", type: "partOf" });
    for (let i = 0; i < 3; i++) {
      g.addNode({ id: `symbol:ios/P${i}`, kind: "symbol", value: 4.99 });
      g.addEdge({ from: `symbol:ios/P${i}`, to: "addon:pro.price", type: "anchors" });
    }
    g.addNode({ id: "symbol:gen/Facts.price", kind: "symbol", value: 4.99, meta: { generated: true } });
    g.addEdge({ from: "symbol:gen/Facts.price", to: "addon:pro.price", type: "anchors" });
    g.addNode({ id: "og:pro", kind: "artifact", types: ["schema:ImageObject"], binding: { adapter: "fs" } });
    g.addNode({ id: "shot:pro", kind: "artifact", types: ["schema:ImageObject"], binding: { adapter: "appstore" } });
    g.addEdge({ from: "og:pro", to: "addon:pro.price", type: "embeds" });
    g.addEdge({ from: "shot:pro", to: "addon:pro.price", type: "embeds" });
    g.addNode({ id: "stripe:price/pro", kind: "artifact", binding: { adapter: "stripe" } });
    g.addEdge({ from: "stripe:price/pro", to: "addon:pro.price", type: "mirrors" });
    g.addNode({ id: "web:pricing", kind: "artifact", binding: { adapter: "fs" } });
    g.addEdge({ from: "web:pricing", to: "addon:pro.price", type: "embeds" });
    g.addNode({ id: "flyer:pro", kind: "artifact" });
    g.addEdge({ from: "flyer:pro", to: "addon:pro.name", type: "embeds" });
    return g;
  }

  it("prices each fact and suggests how to automate it", () => {
    const reports = changeCost(graph());
    expect(reports.map((r) => r.id)).toEqual(["addon:pro.price", "addon:pro.name", "addon:pro"]);
    const price = reports[0]!;
    expect(price.byClass).toMatchObject({ code: 3, auto: 2, manual: 3, info: 1 });
    expect(price.impacted).toBe(9);
    expect(price.hardcoded).toBe(3);
    expect(price.mediaBurnIns).toBe(2);
    expect(price.hours).toBeCloseTo(3 * DEFAULT_HOURS.code + 2 * DEFAULT_HOURS.auto + 3 * DEFAULT_HOURS.manual, 5);
    expect(price.suggestions).toEqual([
      "3 hardcoded code anchors: generate constants with `starchart codegen` to make these auto",
      "2 images embed this value: bind them to a template (renders) to regenerate automatically",
      "1 manual update in stripe: enable write access for this adapter to sync automatically",
      "Doing this cuts the change cost from 5.35 h to 24 min",
    ]);
    expect(reports[1]!.suggestions).toEqual(["1 artifact has no binding: bind it so STARCHART can audit and update it"]);
    expect(reports[2]).toMatchObject({ impacted: 0, hours: 0, suggestions: [] });
  });

  it("honours custom rates and writable adapters", () => {
    const [price] = changeCost(graph(), ["addon:pro.price", "missing"], { hours: { manual: 2 }, canWrite: (a) => a === "fs" || a === "stripe" });
    expect(price!.byClass.manual).toBe(2);
    expect(price!.hours).toBeCloseTo(3 * 0.25 + 3 * 0.05 + 2 * 2, 5);
  });
});
