import { describe, expect, it } from "vitest";
import { Graph } from "../core/graph.js";
import { applyReplacements, auditText, findToken, leafFacts, planReplacements, textForms } from "./text.js";

describe("findToken", () => {
  it("matches numbers only as whole tokens", () => {
    const text = "Pro $4.99/mo. Team 14.99, legacy 4.995 and v4.99x. Ends at 4.99.";
    const hits = findToken(text, "4.99").map((h) => text.slice(h.start - 1, h.end + 1));
    expect(hits).toEqual(["$4.99/", " 4.99."]);
  });

  it("respects word boundaries for strings that start/end with word characters", () => {
    expect(findToken("Pro and Proton and Pros", "Pro")).toHaveLength(1);
    expect(findToken("Get Pro+ now, Pro+!", "Pro+")).toHaveLength(2);
    expect(findToken("Café Pro", "Café")).toHaveLength(1);
    expect(findToken("Cafés", "Café")).toHaveLength(0);
  });

  it("formats numbers with their money form", () => {
    expect(textForms(5)).toEqual(["5", "5.00"]);
    expect(textForms(5.9)).toEqual(["5.9", "5.90"]);
    expect(textForms(5.99)).toEqual(["5.99"]);
  });
});

describe("replacements", () => {
  it("swaps values in one pass without chaining", () => {
    const plan = planReplacements(
      [
        { id: "p.usd", value: 5.99 },
        { id: "p.eur", value: 6.99 },
      ],
      { "p.usd": 4.99, "p.eur": 5.99 },
    );
    // eur's old value 5.99 is usd's new value: that is ambiguous, not chainable
    expect(plan.ambiguous).toEqual([{ fact: "p.eur", value: 5.99, conflictsWith: "p.usd" }]);

    const safe = planReplacements([{ id: "p.usd", value: 5.99 }], { "p.usd": 4.99 });
    const out = applyReplacements("USD 4.99, EUR 14.99, again 4.99", safe.replacements);
    expect(out.text).toBe("USD 5.99, EUR 14.99, again 5.99");
    expect(out.byFact).toEqual({ "p.usd": 2 });
  });

  it("keeps the 2-decimal style of the matched text", () => {
    const { replacements } = planReplacements([{ id: "x", value: 6 }], { x: 5 });
    expect(applyReplacements("only 5.00 today", replacements).text).toBe("only 6.00 today");
  });

  it("pairs changed list items and reports additions it cannot place", () => {
    const plan = planReplacements([{ id: "f", value: ["themes", "cloud sync", "widgets"] }], { f: ["themes", "sync"] });
    expect(plan.replacements).toEqual([{ fact: "f", from: "sync", to: "cloud sync" }]);
    expect(plan.unplaced).toEqual([{ fact: "f", value: "widgets" }]);
  });
});

describe("auditText and leafFacts", () => {
  it("expands containers and reports stale then missing", () => {
    const g = new Graph();
    g.addNode({ id: "addon:pro.price", kind: "fact", value: { usd: 5.99, eur: 5.49 } });
    g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 5.99 });
    g.addNode({ id: "addon:pro.price.eur", kind: "fact", value: 5.49 });
    g.addEdge({ from: "addon:pro.price.usd", to: "addon:pro.price", type: "partOf" });
    g.addEdge({ from: "addon:pro.price.eur", to: "addon:pro.price", type: "partOf" });
    g.addNode({ id: "web:page", kind: "artifact" });
    g.addEdge({ from: "web:page", to: "addon:pro.price", type: "embeds" });

    const facts = leafFacts(g, "web:page");
    expect(facts.map((f) => f.id)).toEqual(["addon:pro.price.eur", "addon:pro.price.usd"]);
    const text = "line one\nPrice: $4.99\n";
    const diffs = auditText({
      artifact: "web:page",
      text,
      facts,
      previous: { "addon:pro.price.usd": 4.99, "addon:pro.price.eur": 5.49 },
      where: (i) => `page:${text.slice(0, i).split("\n").length}`,
      whereMissing: "page",
    });
    expect(diffs).toMatchObject([
      { fact: "addon:pro.price.eur", kind: "missing", where: "page" },
      { fact: "addon:pro.price.usd", kind: "stale", actual: 4.99, where: "page:2" },
    ]);
  });
});
