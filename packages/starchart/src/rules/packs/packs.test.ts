import { describe, expect, it } from "vitest";
import { Graph } from "../../core/graph.js";
import { evaluateRules, type Violation } from "../engine.js";
import { normalizeScreenshotSet } from "./appstore.js";
import { loadPacks, PACKS } from "./index.js";

const NOW = new Date("2026-09-29T12:00:00Z");

const run = (pack: string, g: Graph): Violation[] => evaluateRules(g, loadPacks([pack]).rules, { now: NOW });
const lines = (vs: Violation[]) => vs.map((v) => `${v.severity} ${v.rule} ${v.node}: ${v.message}`);

describe("loadPacks", () => {
  it("loads known packs once and reports unknown ones", () => {
    const { rules, unknown } = loadPacks(["core", "@starchart/pack-appstore", "core", "nope"]);
    expect(unknown).toEqual(["nope"]);
    expect(rules.length).toBe(PACKS.core!.rules.length + PACKS.appstore!.rules.length);
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    for (const r of rules) expect(r.pack).toBeDefined();
  });
});

describe("core pack", () => {
  function graph(): Graph {
    const g = new Graph();
    g.addNode({ id: "addon:pro", kind: "entity", status: "active" });
    g.addNode({ id: "addon:pro.price", kind: "fact", value: { usd: 5.99 } });
    g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 5.99 });
    g.addNode({ id: "addon:pro.status", kind: "fact", value: "active" });
    g.addEdge({ from: "addon:pro.price.usd", to: "addon:pro.price", type: "partOf" });
    g.addEdge({ from: "addon:pro.price", to: "addon:pro", type: "partOf" });
    g.addEdge({ from: "addon:pro.status", to: "addon:pro", type: "partOf" });
    g.addNode({ id: "addon:old", kind: "entity", status: "retired" });
    g.addNode({ id: "addon:old.tagline", kind: "fact", value: "Legacy" });
    g.addEdge({ from: "addon:old.tagline", to: "addon:old", type: "partOf" });
    g.addNode({ id: "addon:beta", kind: "entity" });
    g.addNode({ id: "addon:beta.note", kind: "fact", value: "soon" });
    g.addEdge({ from: "addon:beta.note", to: "addon:beta", type: "partOf" });

    g.addNode({ id: "symbol:ios/Pricing.proUSD", kind: "symbol", value: 4.99, location: { file: "apps/ios/Pricing.swift", line: 12 } });
    g.addEdge({ from: "symbol:ios/Pricing.proUSD", to: "addon:pro.price.usd", type: "anchors" });
    g.addNode({ id: "symbol:web/pricing.PRO", kind: "symbol", value: "5.99", location: { file: "web/pricing.ts", line: 3 } });
    g.addEdge({ from: "symbol:web/pricing.PRO", to: "addon:pro.price.usd", type: "anchors" });
    g.addNode({ id: "symbol:gen/Facts.proUSD", kind: "symbol", value: 1, meta: { generated: true } });
    g.addEdge({ from: "symbol:gen/Facts.proUSD", to: "addon:pro.price.usd", type: "anchors" });

    g.addNode({ id: "web:pricing", kind: "artifact", binding: { adapter: "fs" }, owners: ["@web"] });
    g.addEdge({ from: "web:pricing", to: "addon:pro.price.usd", type: "embeds" });
    g.addNode({ id: "reel:old", kind: "artifact", validThrough: "2026-06-30" });
    g.addEdge({ from: "reel:old", to: "addon:old", type: "promotes" });
    g.addNode({ id: "reel:retired", kind: "artifact", status: "retired", validThrough: "2025-01-01", binding: { adapter: "fs" } });
    g.addEdge({ from: "reel:retired", to: "addon:old", type: "promotes" });
    g.addEdge({ from: "web:pricing", to: "addon:gone", type: "describes" });
    return g;
  }

  it("reports bindings, expiry, retired promotions, unused facts, drift, dangling edges and owners", () => {
    expect(lines(run("core", graph()))).toEqual([
      "error anchor-matches symbol:ios/Pricing.proUSD: addon:pro.price.usd: code says 4.99, fact says 5.99 (apps/ios/Pricing.swift:12)",
      'error no-dangling-edge web:pricing: web:pricing --describes--> addon:gone: "addon:gone" does not exist',
      "error promo-not-expired reel:old: reel:old expired on 2026-06-30",
      "error promotes-active reel:old: reel:old promotes addon:old, which is retired",
      "warn artifact-bound reel:old: reel:old has no binding",
      "info fact-used addon:beta.note: addon:beta.note is not used by any code or artifact",
      "info owners reel:old: reel:old has no owners",
      "info owners reel:retired: reel:retired has no owners",
    ]);
  });

  it("points anchor drift at the source file", () => {
    const v = run("core", graph()).find((x) => x.rule === "anchor-matches")!;
    expect(v.file).toBe("apps/ios/Pricing.swift");
  });

  it("skips the owners rule when nobody declares owners", () => {
    const g = new Graph();
    g.addNode({ id: "a", kind: "artifact", binding: { adapter: "fs" } });
    g.addNode({ id: "f", kind: "fact", value: 1 });
    g.addEdge({ from: "a", to: "f", type: "embeds" });
    expect(run("core", g)).toEqual([]);
  });
});

describe("appstore pack", () => {
  function graph(): Graph {
    const g = new Graph();
    g.addNode({ id: "app:themes", kind: "entity", types: ["sc:App"] });
    g.addNode({ id: "listing:app", kind: "entity", types: ["sc:AppStoreListing"] });
    const facts: Record<string, unknown> = {
      name: { "en-US": "Pro+ Ultimate Deluxe Themes!!!", ja: "テーマ" },
      subtitle: "Beautiful home screens",
      keywords: { "en-US": "themes, widgets, icons", ja: "テーマ,ウィジェット" },
      promotionalText: "x".repeat(171),
    };
    for (const [k, v] of Object.entries(facts)) {
      g.addNode({ id: `listing:app.${k}`, kind: "fact", value: v });
      g.addEdge({ from: `listing:app.${k}`, to: "listing:app", type: "partOf" });
    }
    g.addNode({ id: "appstore:listing/de-DE/name", kind: "artifact", binding: { adapter: "appstore", field: "name" }, meta: { text: "Themen für deinen Startbildschirm" } });
    g.addNode({ id: "appstore:listing/fr/subtitle", kind: "artifact", binding: { adapter: "appstore", field: "subtitle", locale: "fr" } });
    g.addNode({ id: "copy:subtitle", kind: "fact", value: { fr: "Des écrans d'accueil magnifiques et uniques" } });
    g.addEdge({ from: "appstore:listing/fr/subtitle", to: "copy:subtitle", type: "mirrors" });

    g.addNode({ id: "appstore:shots/iphone-55", kind: "artifact", binding: { adapter: "appstore", set: "5.5" } });
    g.addNode({ id: "appstore:shots/ipad-11", kind: "artifact", binding: { adapter: "appstore", set: "APP_IPAD_PRO_3GEN_11" } });
    g.addNode({ id: "appstore:shots/ja-69", kind: "artifact", binding: { adapter: "appstore", set: 6.9, locale: "ja" } });

    g.addNode({ id: "addon:pro", kind: "entity", types: ["schema:Offer"], status: "active" });
    g.addNode({ id: "addon:pro.billing", kind: "fact", value: "monthly" });
    g.addEdge({ from: "addon:pro.billing", to: "addon:pro", type: "partOf" });
    g.addNode({ id: "addon:lifetime", kind: "entity", types: ["schema:Offer"] });
    g.addNode({ id: "addon:lifetime.billing", kind: "fact", value: "once" });
    g.addEdge({ from: "addon:lifetime.billing", to: "addon:lifetime", type: "partOf" });
    g.addNode({ id: "addon:team", kind: "entity", types: ["schema:Offer"] });
    g.addNode({ id: "addon:team.billing", kind: "fact", value: "yearly" });
    g.addEdge({ from: "addon:team.billing", to: "addon:team", type: "partOf" });
    g.addNode({ id: "playstore:sub/team", kind: "artifact", binding: { adapter: "playstore" } });
    g.addEdge({ from: "playstore:sub/team", to: "addon:team.billing", type: "mirrors" });
    return g;
  }

  it("reports the exact App Store findings", () => {
    const got = lines(run("appstore", graph()));
    expect(got).toContain(
      `error appstore-listing-limits listing:app: listing:app promotionalText "${"x".repeat(79)}…" is 171 chars (max 170)`,
    );
    expect(got).toContain('error appstore-screenshot-sets app:themes: missing required iPhone 6.9" (or 6.5") screenshot set; have 5.5"');
    expect(got).toContain('error appstore-screenshot-sets app:themes: missing required iPad 13" (or 12.9") screenshot set; have 11"');
    expect(got).toContain("warn appstore-keywords-spacing listing:app: listing:app keywords [en-US] has spaces after commas (2 of 100 chars wasted)");
    expect(got).toContain("warn appstore-subscription-mirrored addon:pro: addon:pro is a monthly subscription but no App Store or Play Store product mirrors it");
    // a 30-char name is within the limit; the ja locale set has 6.9"; lifetime is not recurring; team is mirrored by Play
    expect(got.some((l) => l.includes("name [en-US]"))).toBe(false);
    expect(got.some((l) => l.includes("for ja"))).toBe(false);
    expect(got.some((l) => l.includes("addon:lifetime") || l.includes("addon:team"))).toBe(false);
  });

  it("flags a 31-char localized name", () => {
    const g = graph();
    g.addNode({ id: "listing:app.name", kind: "fact", value: { "en-US": "Pro+ Ultimate Deluxe Themes!!!!" } });
    expect(lines(run("appstore", g))).toContain(
      'error appstore-listing-limits listing:app: listing:app name [en-US] "Pro+ Ultimate Deluxe Themes!!!!" is 31 chars (max 30)',
    );
  });

  it("does not require subscriptions to be mirrored when the app does not sell in-app", () => {
    const g = new Graph();
    g.addNode({ id: "addon:pro", kind: "entity", types: ["schema:Offer"] });
    g.addNode({ id: "addon:pro.billing", kind: "fact", value: "monthly" });
    g.addEdge({ from: "addon:pro.billing", to: "addon:pro", type: "partOf" });
    expect(run("appstore", g)).toEqual([]);
    g.addNode({ id: "pkg:swift/purchases-ios", kind: "package" });
    expect(run("appstore", g).map((v) => v.rule)).toEqual(["appstore-subscription-mirrored"]);
  });

  it("normalizes screenshot set names", () => {
    expect(normalizeScreenshotSet("6.9")).toBe("6.9");
    expect(normalizeScreenshotSet('6.5"')).toBe("6.5");
    expect(normalizeScreenshotSet(13)).toBe("13");
    expect(normalizeScreenshotSet("APP_IPHONE_67")).toBe("6.7");
    expect(normalizeScreenshotSet("12.9in")).toBe("12.9");
    expect(normalizeScreenshotSet("watch")).toBeUndefined();
  });
});

describe("seo pack", () => {
  it("checks OG image size, JSON-LD bindings and meta lengths", () => {
    const g = new Graph();
    g.addNode({ id: "web:og/pro", kind: "artifact", types: ["schema:ImageObject"], meta: { width: 1200, height: 600 } });
    g.addNode({ id: "web:og/team", kind: "artifact", types: ["schema:ImageObject"], meta: { width: 1200, height: 630 } });
    g.addNode({ id: "web:hero", kind: "artifact", types: ["schema:ImageObject"], meta: { width: 800, height: 600 } });
    g.addNode({ id: "web:card", kind: "artifact", types: ["schema:ImageObject"], tags: ["og"], meta: { width: "1000" } });
    g.addNode({ id: "addon:pro", kind: "entity" });
    g.addNode({ id: "addon:pro.name", kind: "fact", value: "Pro" });
    g.addEdge({ from: "addon:pro.name", to: "addon:pro", type: "partOf" });
    g.addNode({ id: "web:jsonld/pro", kind: "artifact", types: ["sc:JsonLd"] });
    g.addEdge({ from: "web:jsonld/pro", to: "addon:pro.name", type: "renders" });
    g.addNode({ id: "web:jsonld/org", kind: "artifact", tags: ["jsonld"] });
    g.addNode({ id: "web:pricing", kind: "artifact", types: ["schema:WebPage"], meta: { title: "Pricing", description: "d".repeat(161) } });
    expect(lines(run("seo", g))).toEqual([
      "warn seo-meta-length web:pricing: web:pricing description \"" + "d".repeat(79) + '…" is 161 chars (max 160)',
      "warn seo-og-image-size web:card: web:card is 1000x?, Open Graph images should be 1200x630",
      "warn seo-og-image-size web:og/pro: web:og/pro is 1200x600, Open Graph images should be 1200x630",
      "info seo-jsonld-renders-entity web:jsonld/org: web:jsonld/org is JSON-LD but does not render any entity; add renders: <entity>",
    ]);
  });
});
