import { describe, expect, it } from "vitest";
import { Graph } from "../core/graph.js";
import type { AdapterContext } from "./types.js";
import { extractPageText, resolveUrl, urlAdapter } from "./url.js";

const html = `<!doctype html><html><head><title>Pricing</title>
<meta property="og:description" content="Pro+ for &#36;4.99">
<script type="application/ld+json">{"@type":"Offer","price":"5.99","priceCurrency":"USD"}</script>
<style>.x{content:"9.99"}</style></head>
<body><script>var hidden = "7.99";</script><h1>Pro&nbsp;+</h1><p>Now only <b>$5.99</b>/mo</p><!-- 8.99 --></body></html>`;

function setup(): { graph: Graph; ctx: (f: typeof fetch) => AdapterContext } {
  const g = new Graph();
  g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 5.99 });
  g.addNode({ id: "web:pricing", kind: "artifact", binding: { adapter: "url", url: "/pricing" } });
  g.addEdge({ from: "web:pricing", to: "addon:pro.price.usd", type: "embeds" });
  return {
    graph: g,
    ctx: (f) => ({
      root: "/",
      graph: g,
      settings: { site: "https://example.com" },
      env: {},
      fetch: f,
      previousValues: { "addon:pro.price.usd": 4.99 },
      dryRun: false,
    }),
  };
}

describe("url adapter", () => {
  it("extracts visible text, social meta and JSON-LD but not scripts, styles or comments", () => {
    const text = extractPageText(html);
    expect(text).toContain("Now only $5.99 /mo");
    expect(text).toContain("Pro+ for $4.99");
    expect(text).toContain('"price":"5.99"');
    expect(text).not.toMatch(/7\.99|8\.99|9\.99/);
  });

  it("resolves relative urls against the site", () => {
    const node = setup().graph.node("web:pricing")!;
    expect(resolveUrl(node, { site: "https://example.com/base" })).toBe("https://example.com/base/pricing");
    expect(() => resolveUrl(node, {})).toThrow(/needs "site"/);
  });

  it("finds stale values in og tags", async () => {
    const { graph, ctx } = setup();
    const requested: string[] = [];
    const f = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response(html, { status: 200 });
    }) as typeof fetch;
    const diffs = await urlAdapter.audit(graph.node("web:pricing")!, ctx(f));
    expect(requested).toEqual(["https://example.com/pricing"]);
    expect(diffs).toEqual([expect.objectContaining({ kind: "stale", actual: 4.99, where: expect.stringContaining("https://example.com/pricing near") })]);
  });

  it("treats unreachable networks and server errors as audit errors, not drift", async () => {
    const { graph, ctx } = setup();
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(urlAdapter.audit(graph.node("web:pricing")!, ctx(offline))).rejects.toThrow(/request failed: fetch failed/);
    const down = (async () => new Response("", { status: 503, statusText: "Service Unavailable" })) as typeof fetch;
    await expect(urlAdapter.audit(graph.node("web:pricing")!, ctx(down))).rejects.toThrow(/HTTP 503/);
  });

  it("turns a missing page into a break", async () => {
    const { graph, ctx } = setup();
    const f = (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as typeof fetch;
    expect(await urlAdapter.audit(graph.node("web:pricing")!, ctx(f))).toEqual([
      expect.objectContaining({ kind: "break", message: "https://example.com/pricing: HTTP 404 Not Found" }),
    ]);
  });
});
