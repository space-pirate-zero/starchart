import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Graph } from "../core/graph.js";
import { checkValue, defineRule, evaluateRules, parseRules, selectNodes, type CustomRule } from "./engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-09-29T12:00:00Z");

function world(): Graph {
  const g = new Graph();
  g.addNode({ id: "addon:pro", kind: "entity", types: ["schema:Offer"], status: "active", tags: ["pricing"] });
  g.addNode({ id: "addon:pro.price", kind: "fact", value: { usd: 4.99 } });
  g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 4.99 });
  g.addEdge({ from: "addon:pro.price.usd", to: "addon:pro.price", type: "partOf" });
  g.addEdge({ from: "addon:pro.price", to: "addon:pro", type: "partOf" });
  g.addNode({ id: "addon:team", kind: "entity", types: ["schema:Offer"], status: "active" });
  g.addNode({ id: "addon:legacy", kind: "entity", types: ["schema:Offer"], status: "retired" });

  g.addNode({ id: "stripe:price/pro", kind: "artifact", binding: { adapter: "stripe", price: "price_1" } });
  g.addNode({ id: "appstore:iap/pro", kind: "artifact", binding: { adapter: "appstore", product: "pro_monthly" } });
  g.addEdge({ from: "stripe:price/pro", to: "addon:pro.price", type: "mirrors" });
  g.addEdge({ from: "appstore:iap/pro", to: "addon:pro.price.usd", type: "mirrors" });
  g.addNode({ id: "stripe:price/team", kind: "artifact", binding: { adapter: "stripe", price: "price_2" } });
  g.addEdge({ from: "stripe:price/team", to: "addon:team", type: "mirrors" });

  g.addNode({ id: "listing:app", kind: "entity", types: ["sc:AppStoreListing"] });
  g.addNode({ id: "listing:app.name", kind: "fact", value: { "en-US": "Pro+ Ultimate Deluxe Themes!!!!", ja: "テーマ" } });
  g.addEdge({ from: "listing:app.name", to: "listing:app", type: "partOf" });

  g.addNode({
    id: "promo:spring",
    kind: "artifact",
    tags: ["promo"],
    binding: { adapter: "fs" },
    validThrough: "2026-06-30",
    meta: { publishedAt: "2026-03-01", file: ".starchart/world/promo.yaml" },
  });
  g.addNode({ id: "promo:fall", kind: "artifact", tags: ["promo"], binding: { adapter: "fs" }, owners: ["@growth"], meta: { publishedAt: "2026-09-01" } });
  g.addNode({ id: "promo:old", kind: "artifact", tags: ["promo"], status: "retired", validThrough: "2025-01-01" });

  g.addNode({ id: "screen:ios/Paywall", kind: "screen", meta: { flow: "onboarding" } });
  g.addNode({ id: "screen:ios/Welcome", kind: "screen", meta: { flow: "onboarding" } });
  g.addNode({ id: "appstore:shot/03", kind: "artifact", binding: { adapter: "appstore", set: "6.9" } });
  g.addEdge({ from: "appstore:shot/03", to: "screen:ios/Paywall", type: "captures" });
  return g;
}

function loadYamlRules(): ReturnType<typeof parseRules> {
  const doc = parse(readFileSync(join(here, "fixtures/rules.yaml"), "utf8")) as { rules: Record<string, unknown>[] };
  return parseRules(doc.rules.map((r) => ({ ...r, file: ".starchart/rules.yaml" })));
}

describe("parseRules", () => {
  it("parses the YAML example and applies defaults", () => {
    const { rules, errors } = loadYamlRules();
    expect(errors).toEqual([]);
    expect(rules.map((r) => r.id)).toEqual(["offer-mirrored", "listing-name-length", "promo-fresh", "paywall-captured"]);
    const offer = rules[0]!;
    expect("require" in offer && offer.require.edge?.[0]).toEqual({ type: "mirrors", direction: "in", min: 1, adapter: "stripe" });
    expect("select" in offer && offer.select.kind).toEqual(["entity"]);
    expect(rules[3]!.severity).toBe("info");
    expect(rules[0]!.file).toBe(".starchart/rules.yaml");
  });

  it("reports readable errors with file and rule id", () => {
    const { rules, errors } = parseRules([
      { id: "bad-edge", file: "a.yaml", select: { kind: "artifact" }, require: { edge: { type: "likes" } } },
      { id: "typo", file: "a.yaml", select: { knd: "artifact" }, require: { bound: true } },
      { id: "empty", file: "b.yaml", require: {} },
      { id: "regex", require: { value: { pattern: "([" } } },
      { id: "sev", severity: "fatal", require: { bound: true } },
      { id: "ok", file: "b.yaml", require: { bound: true } },
      { id: "ok", file: "c.yaml", require: { owners: true } },
      "nope",
    ]);
    expect(rules.map((r) => r.id)).toEqual(["ok"]);
    expect(errors[0]).toBe('a.yaml: rule "bad-edge": require.edge.0.type: unknown edge type');
    expect(errors[1]).toMatch(/^a\.yaml: rule "typo": select: Unrecognized key.*knd/);
    expect(errors[2]).toMatch(/^b\.yaml: rule "empty": require: require must list at least one predicate/);
    expect(errors[3]).toMatch(/rule "regex": require\.value\.0\.pattern: invalid regular expression/);
    expect(errors[4]).toMatch(/rule "sev": severity/);
    expect(errors[5]).toBe('c.yaml: rule "ok": duplicate rule id (first declared in b.yaml)');
    expect(errors[6]).toBe("rules: rule #8: rule must be a mapping");
  });

  it("passes custom function rules through", () => {
    const custom: CustomRule = { id: "custom", severity: "warn", check: () => [] };
    const { rules, errors } = parseRules([custom]);
    expect(errors).toEqual([]);
    expect(rules[0]).toBe(custom);
  });
});

describe("selectors", () => {
  const g = world();
  it("filters by kind, type, prefix, tag, adapter, where and whereNot", () => {
    const ids = (select: Parameters<typeof selectNodes>[1]) => selectNodes(g, select).map((n) => n.id);
    expect(ids({ kind: ["entity"], type: ["schema:Offer"] })).toEqual(["addon:legacy", "addon:pro", "addon:team"]);
    expect(ids({ type: ["schema:Offer"], where: { status: "active" } })).toEqual(["addon:pro", "addon:team"]);
    expect(ids({ type: ["schema:Offer"], whereNot: { status: ["retired", "deprecated"] } })).toEqual(["addon:pro", "addon:team"]);
    expect(ids({ prefix: ["stripe:", "appstore:iap"] })).toEqual(["appstore:iap/pro", "stripe:price/pro", "stripe:price/team"]);
    expect(ids({ tag: ["pricing"] })).toEqual(["addon:pro"]);
    expect(ids({ adapter: ["appstore"] })).toEqual(["appstore:iap/pro", "appstore:shot/03"]);
    expect(ids({ where: { "meta.flow": "onboarding" } })).toEqual(["screen:ios/Paywall", "screen:ios/Welcome"]);
    expect(ids({ where: { "binding.set": "6.9" } })).toEqual(["appstore:shot/03"]);
  });
});

describe("evaluateRules", () => {
  it("evaluates the YAML example end to end", () => {
    const { rules } = loadYamlRules();
    const vs = evaluateRules(world(), rules, { now: NOW });
    expect(vs.map((v) => `${v.severity} ${v.rule} ${v.node}: ${v.message}`)).toEqual([
      "error offer-mirrored addon:team: addon:team has 0 incoming mirrors from an appstore artifact (min 1)",
      'warn listing-name-length listing:app: listing:app name [en-US] "Pro+ Ultimate Deluxe Themes!!!!" is 31 chars (max 30)',
      "warn promo-fresh promo:spring: promo:spring expired on 2026-06-30",
      "warn promo-fresh promo:spring: promo:spring has no owners",
      "warn promo-fresh promo:spring: promo:spring meta.publishedAt is 212 days old (max 90)",
      "info paywall-captured screen:ios/Welcome: screen:ios/Welcome is reached by 0 appstore:* node(s) via captures (min 1)",
    ]);
    const spring = vs.find((v) => v.node === "promo:spring")!;
    expect(spring.file).toBe(".starchart/world/promo.yaml");
    expect(vs[0]!.file).toBe(".starchart/rules.yaml");
  });

  it("counts entity facts for incoming edges unless via is disabled", () => {
    const g = world();
    const viaFacts = defineRule({ id: "r", select: { prefix: "addon:pro", kind: "entity" }, require: { edge: { type: "mirrors", direction: "in", min: 2 } } });
    expect(evaluateRules(g, [viaFacts], { now: NOW })).toEqual([]);
    const direct = defineRule({ id: "r", select: { prefix: "addon:pro", kind: "entity" }, require: { edge: { type: "mirrors", direction: "in", via: "none" } } });
    expect(evaluateRules(g, [direct], { now: NOW })[0]!.message).toBe("addon:pro has 0 incoming mirrors (min 1)");
  });

  it("supports out edges with to-prefix and max", () => {
    const g = world();
    const rule = defineRule({
      id: "stripe-mirrors-one",
      select: { adapter: "stripe" },
      require: { edge: { type: "mirrors", to: "addon:pro*", min: 0, max: 0 } },
    });
    const vs = evaluateRules(g, [rule], { now: NOW });
    expect(vs.map((v) => v.message)).toEqual(["stripe:price/pro has 1 outgoing mirrors to addon:pro* (max 0): addon:pro.price"]);
  });

  it("checks bound, pattern, equals and oneOf", () => {
    const g = world();
    g.addNode({ id: "web:unbound", kind: "artifact", types: ["schema:WebPage"] });
    const rules = [
      defineRule({ id: "bound", select: { kind: "artifact", type: "schema:WebPage" }, require: { bound: true } }),
      defineRule({ id: "price", select: { kind: "entity", tag: "pricing" }, require: { value: [{ fact: "price.usd", equals: 5.99 }, { fact: "price.usd", oneOf: [4.99, 9.99] }] } }),
      defineRule({ id: "pattern", select: { kind: "entity", type: "sc:AppStoreListing" }, require: { value: { fact: "name", pattern: "^[A-Za-z+ !]+$", locales: ["ja"] } } }),
      defineRule({ id: "required", select: { kind: "entity", type: "sc:AppStoreListing" }, require: { value: { fact: "subtitle", required: true } } }),
    ];
    const messages = evaluateRules(g, rules, { now: NOW }).map((v) => `${v.rule}: ${v.message}`);
    expect(messages).toEqual([
      "bound: web:unbound has no binding",
      "pattern: listing:app name [ja] \"テーマ\" does not match /^[A-Za-z+ !]+$/",
      "price: addon:pro price.usd is 4.99, expected 5.99",
      "required: listing:app subtitle has no value",
    ]);
  });

  it("runs custom rules and fills defaults", () => {
    const rule: CustomRule = {
      id: "custom",
      severity: "warn",
      pack: "mine",
      check: (graph, ctx) => [{ node: "addon:pro", message: `${graph.size.nodes} nodes at ${ctx.now.toISOString()}` }, { node: "addon:team", message: "x", severity: "info" }],
    };
    const vs = evaluateRules(world(), [rule], { now: NOW });
    expect(vs[0]).toMatchObject({ rule: "custom", severity: "warn", pack: "mine", node: "addon:pro" });
    expect(vs[1]).toMatchObject({ severity: "info", node: "addon:team" });
  });
});

describe("checkValue", () => {
  it("reports missing locales from an explicit list", () => {
    expect(checkValue({ "en-US": "Hi" }, { maxLength: 30, locales: ["en-US", "de-DE"] }, "x")).toEqual(["x is missing locale de-DE"]);
  });
  it("counts code points, not UTF-16 units", () => {
    expect(checkValue("🚀".repeat(30), { maxLength: 30 }, "x")).toEqual([]);
  });
  it("compares whole locale maps with equals", () => {
    expect(checkValue({ en: "a" }, { equals: { en: "a" } }, "x")).toEqual([]);
    expect(checkValue({ en: "a" }, { equals: { en: "b" } }, "x")).toEqual(['x is {"en":"a"}, expected {"en":"b"}']);
  });
});
