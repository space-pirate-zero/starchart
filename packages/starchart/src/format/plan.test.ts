import { describe, expect, it } from "vitest";
import { summarize, type Plan } from "../api.js";
import { Graph } from "../core/graph.js";
import { computeImpact } from "../core/impact.js";
import { orderSteps } from "../core/order.js";
import { formatPlanJson, formatPlanMarkdown, formatPlanText, formatStaleMarkdown, formatStaleText } from "./plan.js";

const now = new Date("2026-09-29T00:00:00Z");

function universe(): Graph {
  const g = new Graph();
  g.addNode({ id: "addon:pro", kind: "entity", status: "active" });
  g.addNode({ id: "addon:pro.price", kind: "fact", value: { usd: 5.99 } });
  g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 5.99 });
  g.addEdge({ from: "addon:pro.price.usd", to: "addon:pro.price", type: "partOf" });
  g.addEdge({ from: "addon:pro.price", to: "addon:pro", type: "partOf" });
  g.addNode({ id: "symbol:ios/Pricing.proUSD", kind: "symbol", hash: "p1", value: 5.99 });
  g.addEdge({ from: "symbol:ios/Pricing.proUSD", to: "addon:pro.price.usd", type: "anchors" });
  g.addNode({ id: "web:pricing", kind: "artifact", binding: { adapter: "fs", path: "web/pricing.html" } });
  g.addNode({ id: "stripe:price/pro", kind: "artifact", binding: { adapter: "stripe" } });
  g.addNode({ id: "web:landing|hero", kind: "artifact" });
  g.addEdge({ from: "web:pricing", to: "addon:pro.price.usd", type: "embeds" });
  g.addEdge({ from: "stripe:price/pro", to: "addon:pro.price", type: "mirrors" });
  g.addEdge({ from: "web:landing|hero", to: "addon:pro", type: "describes" });
  g.addEdge({ from: "web:pricing", to: "stripe:price/pro", type: "after" });
  return g;
}

function plan(): Plan {
  const g = universe();
  const impact = computeImpact(g, ["addon:pro.price.usd"], { now });
  const actionable = impact.items.filter((i) => i.class !== "info" && i.class !== "test");
  const { steps, cycles } = orderSteps(g, actionable);
  return { changes: [{ id: "addon:pro.price.usd", before: 4.99, after: 5.99 }], impact, steps, cycles, summary: summarize(impact.items) };
}

describe("formatPlanText", () => {
  it("renders a Terraform-style plan without color", () => {
    const text = formatPlanText(plan());
    expect(text).toContain("Change: addon:pro.price.usd  4.99 → 5.99");
    expect(text).toMatch(/! manual\s+stripe:price\/pro\s+mirrors/);
    expect(text).toMatch(/~ auto\s+web:pricing\s+embeds\s+replace embedded value|! manual\s+web:pricing/);
    expect(text).toMatch(/\? review\s+web:landing\|hero\s+describes/);
    expect(text).toMatch(/⌘ code\s+symbol:ios\/Pricing\.proUSD\s+anchors/);
    expect(text).toContain("Order: stripe:price/pro → ");
    expect(text).toMatch(/Plan: .*1 review/);
    expect(text).not.toContain("\u001b[");
    // informational items are hidden unless verbose
    expect(text).not.toMatch(/· info\s+addon:pro\.price /);
    expect(text).toContain("informational item");
  });

  it("orders items by class urgency and shows why-paths when verbose", () => {
    const text = formatPlanText(plan(), { verbose: true });
    expect(text.indexOf("! manual")).toBeLessThan(text.indexOf("? review"));
    expect(text).toContain("why: addon:pro.price.usd --partOf--> addon:pro.price --mirrors--> stripe:price/pro");
    expect(text).toMatch(/· info\s+addon:pro\.price /);
  });

  it("colors output when asked", () => {
    const text = formatPlanText(plan(), { color: true });
    expect(text).toContain("\u001b[");
  });

  it("handles an empty plan", () => {
    const empty: Plan = {
      changes: [],
      impact: { seeds: [], items: [] },
      steps: [],
      cycles: [],
      summary: summarize([]),
    };
    expect(formatPlanText(empty)).toContain("No cross-layer impact.");
    expect(formatPlanMarkdown(empty)).toContain("No cross-layer impact.");
  });
});

describe("formatPlanMarkdown", () => {
  it("renders a PR comment with summary, grouped sections and rollout order", () => {
    const md = formatPlanMarkdown(plan());
    expect(md.startsWith("## 🌌 STARCHART blast radius")).toBe(true);
    expect(md).toContain("- `addon:pro.price.usd` `4.99` → `5.99`");
    expect(md).toContain("| ! | Manual |");
    expect(md).toContain("<details open><summary><b>! Manual</b>");
    expect(md).toContain("<summary><b>? Needs review</b> (1)</summary>");
    // pipes inside ids are escaped so the table does not break
    expect(md).toContain("`web:landing\\|hero`");
    expect(md).toContain("<code>addon:pro.price.usd --partOf--&gt; addon:pro.price --mirrors--&gt; stripe:price/pro</code>");
    expect(md).toContain("### Rollout order");
    expect(md).toMatch(/1\. `stripe:price\/pro` \(manual\)/);
    expect(md).toContain("after `stripe:price/pro`");
  });

  it("truncates long sections", () => {
    const md = formatPlanMarkdown(plan(), { maxItems: 0, title: "Impact" });
    expect(md.startsWith("## Impact")).toBe(true);
    expect(md).toContain("…and 1 more");
  });
});

describe("formatPlanJson", () => {
  it("produces a stable JSON-safe structure", () => {
    const json = formatPlanJson(plan());
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(json.changes).toEqual([{ id: "addon:pro.price.usd", before: 4.99, after: 5.99 }]);
    const stripe = json.items.find((i) => i.id === "stripe:price/pro");
    expect(stripe).toMatchObject({ class: "manual", via: "mirrors", depth: 2, confidence: 1, layer: "world" });
    expect(stripe?.why).toContain("--mirrors--> stripe:price/pro");
    expect(json.steps[0]).toEqual({ id: "stripe:price/pro", class: "manual", waitsFor: [] });
    expect(json.summary.review).toBe(1);
  });
});

describe("formatStale", () => {
  const stale = [
    { id: "web:pricing", changed: ["addon:pro.price.usd"], unlocked: false },
    { id: "web:new", changed: [], unlocked: true },
  ];
  it("renders text", () => {
    const text = formatStaleText(stale);
    expect(text).toContain("✗ stale");
    expect(text).toContain("changed: addon:pro.price.usd");
    expect(text).toContain("Check: 1 stale · 1 unlocked");
    expect(formatStaleText([])).toContain("in sync");
  });
  it("renders markdown", () => {
    const md = formatStaleMarkdown(stale);
    expect(md).toContain("| `web:pricing` | ✗ stale | `addon:pro.price.usd` |");
    expect(md).toContain("| `web:new` | ? unlocked | never locked |");
    expect(formatStaleMarkdown([])).toContain("✅");
  });
});
