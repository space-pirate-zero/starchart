import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Graph } from "../core/graph.js";
import type { GraphNode } from "../core/model.js";
import { computeFsUpdate, fsAdapter, parseJsonPath } from "./fs.js";
import type { AdapterContext } from "./types.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "starchart-fs-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function proGraph(usd = 5.99, name = "Pro+"): Graph {
  const g = new Graph();
  g.addNode({ id: "addon:pro", kind: "entity" });
  g.addNode({ id: "addon:pro.price", kind: "fact", value: { usd } });
  g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: usd });
  g.addNode({ id: "addon:pro.name", kind: "fact", value: name });
  g.addEdge({ from: "addon:pro.price.usd", to: "addon:pro.price", type: "partOf" });
  g.addEdge({ from: "addon:pro.price", to: "addon:pro", type: "partOf" });
  g.addEdge({ from: "addon:pro.name", to: "addon:pro", type: "partOf" });
  return g;
}

function artifact(g: Graph, id: string, binding: Record<string, unknown>, embeds: string[], meta?: Record<string, unknown>): GraphNode {
  const node = g.addNode({ id, kind: "artifact", binding: { adapter: "fs", ...binding }, meta });
  for (const to of embeds) g.addEdge({ from: id, to, type: "embeds" });
  return node;
}

function ctx(g: Graph, previousValues: Record<string, unknown>, dryRun = false): AdapterContext {
  return { root, graph: g, settings: {}, env: {}, fetch: globalThis.fetch, previousValues, dryRun };
}

describe("fs audit", () => {
  it("reports stale old values with file:line and respects token boundaries", async () => {
    writeFileSync(join(root, "pricing.md"), "# Pricing\n\nPro+ is $4.99 a month.\nTeam is $14.99.\n");
    const g = proGraph(5.99);
    const node = artifact(g, "web:pricing", { path: "pricing.md" }, ["addon:pro.price", "addon:pro.name"]);
    const diffs = await fsAdapter.audit(node, ctx(g, { "addon:pro.price.usd": 4.99, "addon:pro.name": "Pro+" }));
    expect(diffs).toEqual([
      expect.objectContaining({ fact: "addon:pro.price.usd", kind: "stale", where: "pricing.md:3", actual: 4.99, expected: 5.99 }),
    ]);
  });

  it("reports missing values and a missing file", async () => {
    writeFileSync(join(root, "a.txt"), "costs 14.99 or 4.995\n");
    const g = proGraph(4.99);
    const node = artifact(g, "web:a", { path: "a.txt" }, ["addon:pro.price.usd"]);
    expect(await fsAdapter.audit(node, ctx(g, { "addon:pro.price.usd": 4.99 }))).toEqual([
      expect.objectContaining({ kind: "missing", fact: "addon:pro.price.usd", where: "a.txt" }),
    ]);
    const gone = artifact(g, "web:gone", { path: "nope.txt" }, ["addon:pro.price.usd"]);
    expect((await fsAdapter.audit(gone, ctx(g, {})))[0]).toMatchObject({ kind: "missing", message: "file not found: nope.txt" });
  });

  it("restricts to a regex selector region", async () => {
    writeFileSync(join(root, "p.tsx"), 'const old = "4.99";\nexport const PRICE = "4.99";\n');
    const g = proGraph(5.99);
    const node = artifact(g, "web:p", { path: "p.tsx", selector: 'regex:PRICE = "([^"]+)"' }, ["addon:pro.price.usd"]);
    const diffs = await fsAdapter.audit(node, ctx(g, { "addon:pro.price.usd": 4.99 }));
    expect(diffs).toEqual([expect.objectContaining({ kind: "stale", where: "p.tsx:2" })]);

    const result = await fsAdapter.apply!(node, ctx(g, { "addon:pro.price.usd": 4.99 }));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "p.tsx"), "utf8")).toBe('const old = "4.99";\nexport const PRICE = "5.99";\n');
  });

  it("parses JSON paths", () => {
    expect(parseJsonPath("$.plans[0].price")).toEqual(["plans", 0, "price"]);
    expect(parseJsonPath('$["a b"].c')).toEqual(["a b", "c"]);
    expect(parseJsonPath("a.b")).toEqual(["a", "b"]);
    expect(() => parseJsonPath("$..x")).toThrow(/invalid JSON path/);
  });
});

describe("fs apply / revert", () => {
  it("replaces changed values, writes an undo record, and reverts", async () => {
    const original = "Pro+ costs $4.99/mo (was 14.99).\nOnly $4.99!\n";
    writeFileSync(join(root, "page.html"), original);
    const g = proGraph(5.99, "Pro Max");
    const node = artifact(g, "web:page", { path: "page.html" }, ["addon:pro.price.usd", "addon:pro.name"]);
    const prev = { "addon:pro.price.usd": 4.99, "addon:pro.name": "Pro+" };

    const dry = await fsAdapter.apply!(node, ctx(g, prev, true));
    expect(dry.ok).toBe(true);
    expect(dry.changes[0]).toMatch(/^would /);
    expect(readFileSync(join(root, "page.html"), "utf8")).toBe(original);

    const result = await fsAdapter.apply!(node, ctx(g, prev));
    expect(result.ok).toBe(true);
    expect(result.changes).toEqual(['addon:pro.price.usd: 4.99 → 5.99', 'addon:pro.name: "Pro+" → "Pro Max"']);
    expect(readFileSync(join(root, "page.html"), "utf8")).toBe("Pro Max costs $5.99/mo (was 14.99).\nOnly $5.99!\n");
    expect(result.undo).toMatchObject({ adapter: "fs", artifact: "web:page", data: { path: "page.html", existed: true } });

    const again = await fsAdapter.apply!(node, ctx(g, prev));
    expect(again).toMatchObject({ ok: true, changes: [] });

    const reverted = await fsAdapter.revert!(result.undo!, ctx(g, prev));
    expect(reverted.ok).toBe(true);
    expect(readFileSync(join(root, "page.html"), "utf8")).toBe(original);
  });

  it("updates a JSON selector target and keeps numbers numeric", async () => {
    writeFileSync(join(root, "plans.json"), JSON.stringify({ plans: { pro: { price: 4.99, label: "Pro+ 4.99" } }, other: 4.99 }, null, 2) + "\n");
    const g = proGraph(5.99);
    const node = artifact(g, "web:json", { path: "plans.json", selector: "json:$.plans.pro" }, ["addon:pro.price.usd"]);
    const result = await fsAdapter.apply!(node, ctx(g, { "addon:pro.price.usd": 4.99 }));
    expect(result.ok).toBe(true);
    const doc = JSON.parse(readFileSync(join(root, "plans.json"), "utf8"));
    expect(doc).toEqual({ plans: { pro: { price: 5.99, label: "Pro+ 5.99" } }, other: 4.99 });
  });

  it("refuses ambiguous and unfindable replacements", async () => {
    writeFileSync(join(root, "x.txt"), "no price here\n");
    const g = proGraph(5.99);
    const node = artifact(g, "web:x", { path: "x.txt" }, ["addon:pro.price.usd"]);
    const result = await fsAdapter.apply!(node, ctx(g, { "addon:pro.price.usd": 4.99 }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not find old value 4.99/);

    g.addNode({ id: "addon:pro.price.gbp", kind: "fact", value: 4.99 });
    g.addEdge({ from: "web:x", to: "addon:pro.price.gbp", type: "embeds" });
    writeFileSync(join(root, "x.txt"), "USD 4.99 GBP 4.99\n");
    const amb = await fsAdapter.apply!(node, ctx(g, { "addon:pro.price.usd": 4.99, "addon:pro.price.gbp": 4.99 }));
    expect(amb.ok).toBe(false);
    expect(amb.error).toMatch(/ambiguous/);
  });

  it("renders templates, rasterizes SVG to PNG, and reverts by removing new files", async () => {
    mkdirSync(join(root, "tpl"));
    writeFileSync(
      join(root, "tpl/og.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#ff1493"/><text x="4" y="30">{{ addon:pro.name }} {{ addon:pro.price.usd | money:USD }}</text></svg>',
    );
    const g = proGraph(5.99, "Pro & Co");
    const svgNode = artifact(g, "web:og-svg", { path: "out/og.svg" }, [], { template: "tpl/og.svg" });
    g.addEdge({ from: "web:og-svg", to: "addon:pro.price.usd", type: "renders" });
    const svgResult = await fsAdapter.apply!(svgNode, ctx(g, {}));
    expect(svgResult.ok).toBe(true);
    expect(readFileSync(join(root, "out/og.svg"), "utf8")).toContain("Pro &amp; Co $5.99");
    expect(await fsAdapter.audit(svgNode, ctx(g, {}))).toEqual([]);

    const pngNode = artifact(g, "web:og-png", {}, [], { template: "tpl/og.svg", templateOut: "out/og.png" });
    const update = await computeFsUpdate(pngNode, ctx(g, {}));
    expect(update.kind).toBe("png");
    expect(update.after.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const pngResult = await fsAdapter.apply!(pngNode, ctx(g, {}));
    expect(pngResult.undo?.data.existed).toBe(false);
    expect(await fsAdapter.audit(pngNode, ctx(g, {}))).toEqual([]);

    g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 6.99 });
    expect(await fsAdapter.audit(pngNode, ctx(g, {}))).toEqual([expect.objectContaining({ kind: "mismatch" })]);

    await fsAdapter.revert!(pngResult.undo!, ctx(g, {}));
    expect(existsSync(join(root, "out/og.png"))).toBe(false);
  });

  it("refuses paths outside the root", async () => {
    const g = proGraph();
    const node = artifact(g, "web:evil", { path: "../outside.txt" }, ["addon:pro.price.usd"]);
    const result = await fsAdapter.apply!(node, ctx(g, { "addon:pro.price.usd": 4.99 }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside the project root/);
  });
});
