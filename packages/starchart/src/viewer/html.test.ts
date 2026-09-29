import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Graph } from "../core/graph.js";
import { PROPAGATION } from "../core/model.js";
import { computeStats, escapeHtml, renderViewerHtml, safeJson, type ViewerData } from "./html.js";

function sample(): ViewerData {
  const g = new Graph();
  g.addNode({ id: "addon:pro", kind: "entity", label: "Pro" });
  g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 5.99 });
  g.addNode({ id: "web:</script><script>alert(1)</script>", kind: "artifact", label: "<img src=x onerror=alert(2)>" });
  g.addNode({ id: "symbol:app/Price", kind: "symbol", value: "</script>" });
  g.addNode({ id: "screen:app/Paywall", kind: "screen" });
  g.addEdge({ from: "addon:pro.price.usd", to: "addon:pro", type: "partOf" });
  g.addEdge({ from: "web:</script><script>alert(1)</script>", to: "addon:pro.price.usd", type: "embeds" });
  g.addEdge({ from: "symbol:app/Price", to: "addon:pro.price.usd", type: "anchors" });
  g.addEdge({ from: "screen:app/Paywall", to: "symbol:app/Price", type: "references" });
  return {
    name: "Demo <Universe> & co",
    graph: g.toJSON(),
    stale: ["web:</script><script>alert(1)</script>"],
    generatedAt: "2026-09-29T00:00:00.000Z",
    lockFacts: { "addon:pro.price.usd": 4.99 },
  };
}

function dataScript(html: string): string {
  const m = /<script type="application\/json" id="starchart-data">([\s\S]*?)<\/script>/.exec(html);
  if (!m?.[1]) throw new Error("data script not found");
  return m[1];
}

describe("renderViewerHtml", () => {
  it("embeds data so hostile ids cannot break out of the JSON script", () => {
    const data = sample();
    const html = renderViewerHtml(data);
    const raw = dataScript(html);
    expect(raw).not.toContain("<");
    expect(raw).not.toContain(">");
    const parsed = JSON.parse(raw) as { graph: ViewerData["graph"]; stale: string[]; name: string };
    expect(parsed.graph.nodes.map((n) => n.id)).toContain("web:</script><script>alert(1)</script>");
    expect(parsed.stale).toEqual(data.stale);
    expect(parsed.name).toBe(data.name);
    // exactly three script elements: data, impact core, viewer
    expect(html.match(/<script\b/g)).toHaveLength(3);
    expect(html.match(/<\/script>/g)).toHaveLength(3);
    expect(html).not.toContain("<img src=x");
  });

  it("escapes the title and computes stats into the header", () => {
    const html = renderViewerHtml(sample());
    expect(html).toContain("<title>STARCHART — Demo &lt;Universe&gt; &amp; co</title>");
    expect(html).toMatch(/<div class="stat world"[^>]*><dt>WORLD<\/dt><dd>1<\/dd>/);
    expect(html).toMatch(/<div class="stat fact"[^>]*><dt>FACTS<\/dt><dd>2<\/dd>/);
    expect(html).toMatch(/<div class="stat code"[^>]*><dt>CODE<\/dt><dd>2<\/dd>/);
    expect(html).toMatch(/<div class="stat stale hot"[^>]*><dt>STALE<\/dt><dd>1<\/dd>/);
  });

  it("injects the core propagation table and impact config", () => {
    const parsed = JSON.parse(dataScript(renderViewerHtml({ ...sample(), maxCodeDepth: 2, writableAdapters: ["fs"] }))) as {
      impact: { propagation: unknown; maxCodeDepth: number; writable: string[] };
      lockFacts: Record<string, unknown>;
    };
    expect(parsed.impact.propagation).toEqual(PROPAGATION);
    expect(parsed.impact.maxCodeDepth).toBe(2);
    expect(parsed.impact.writable).toEqual(["fs"]);
    expect(parsed.lockFacts["addon:pro.price.usd"]).toBe(4.99);
  });

  it("is self-contained and pins its inline scripts and style with CSP hashes", () => {
    const html = renderViewerHtml(sample());
    expect(html).not.toMatch(/<(link|img|iframe)\b/);
    expect(html).not.toMatch(/src="http|href="http|@import|url\(http/);
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
    expect(scripts).toHaveLength(2);
    for (const s of scripts) {
      const hash = createHash("sha256").update(s, "utf8").digest("base64");
      expect(csp).toContain(`'sha256-${hash}'`);
    }
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    expect(csp).toContain(`'sha256-${createHash("sha256").update(style, "utf8").digest("base64")}'`);
  });

  it("ships client scripts that parse", () => {
    for (const file of ["viewer.js", "impact-core.js"]) {
      const source = readFileSync(new URL(`./assets/${file}`, import.meta.url), "utf8");
      expect(() => new Function(source)).not.toThrow();
      expect(source).not.toMatch(/console\.log|TODO|FIXME/);
    }
  });
});

describe("computeStats", () => {
  it("counts nodes per layer and edges per layer or bridge", () => {
    const stats = computeStats(sample());
    expect(stats.nodes).toEqual({ world: 1, fact: 2, code: 2 });
    expect(stats.edges).toEqual({ world: 0, fact: 1, code: 1, bridge: 2 });
    expect(stats.totalNodes).toBe(5);
    expect(stats.totalEdges).toBe(4);
    expect(stats.stale).toBe(1);
  });
});

describe("escaping helpers", () => {
  it("escapes HTML and JSON", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    const json = safeJson({ s: "</script><!-- &\u2028" });
    expect(json).not.toMatch(/[<>&\u2028]/);
    expect(JSON.parse(json)).toEqual({ s: "</script><!-- &\u2028" });
  });
});
