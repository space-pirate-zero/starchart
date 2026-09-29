import { describe, expect, it } from "vitest";
import { Graph } from "../core/graph.js";
import type { GraphNode } from "../core/model.js";
import { MissingCredentialsError } from "./errors.js";
import { encodeForm, stripeAdapter, type StripePrice } from "./stripe.js";
import type { AdapterContext } from "./types.js";

interface Call {
  method: string;
  url: string;
  body?: string;
  auth?: string;
}

type Route = (call: Call) => { status?: number; json: unknown } | undefined;

function fakeFetch(routes: Route[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? init.body : undefined,
      auth: headers.get("authorization") ?? undefined,
    };
    calls.push(call);
    for (const route of routes) {
      const hit = route(call);
      if (hit) return new Response(JSON.stringify(hit.json), { status: hit.status ?? 200 });
    }
    return new Response(JSON.stringify({ error: { message: `no route for ${call.method} ${call.url}` } }), { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const API = "https://api.stripe.com/v1";

const basePrice: StripePrice = {
  id: "price_old",
  active: true,
  currency: "usd",
  unit_amount: 499,
  product: "prod_pro",
  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  lookup_key: "pro_monthly",
  nickname: "Pro monthly",
  tax_behavior: "exclusive",
  currency_options: { usd: { unit_amount: 499, tax_behavior: "exclusive" }, eur: { unit_amount: 499, tax_behavior: "exclusive" } },
  metadata: { tier: "pro" },
};

function setup(price: Partial<StripePrice> = {}, productName = "Pro+"): { graph: Graph; node: GraphNode; routes: Route[] } {
  const g = new Graph();
  g.addNode({ id: "addon:pro", kind: "entity" });
  g.addNode({ id: "addon:pro.price", kind: "fact", value: { usd: 5.99, eur: 5.49 } });
  g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 5.99 });
  g.addNode({ id: "addon:pro.price.eur", kind: "fact", value: 5.49 });
  g.addNode({ id: "addon:pro.name", kind: "fact", value: "Pro Max" });
  g.addEdge({ from: "addon:pro.price.usd", to: "addon:pro.price", type: "partOf" });
  g.addEdge({ from: "addon:pro.price.eur", to: "addon:pro.price", type: "partOf" });
  const node = g.addNode({ id: "stripe:price/pro", kind: "artifact", binding: { adapter: "stripe", price: "price_old" } });
  g.addEdge({ from: node.id, to: "addon:pro.price", type: "mirrors" });
  g.addEdge({ from: node.id, to: "addon:pro.name", type: "mirrors" });
  const current = { ...basePrice, ...price };
  const routes: Route[] = [
    (c) => (c.method === "GET" && c.url === `${API}/prices/price_old?expand%5B%5D=currency_options` ? { json: current } : undefined),
    (c) => (c.method === "GET" && c.url === `${API}/products/prod_pro` ? { json: { id: "prod_pro", name: productName, active: true } } : undefined),
  ];
  return { graph: g, node, routes };
}

function ctx(graph: Graph, f: typeof fetch, extra: Partial<AdapterContext> = {}): AdapterContext {
  return { root: "/", graph, settings: {}, env: { STRIPE_SECRET_KEY: "sk_test_123" }, fetch: f, previousValues: {}, dryRun: false, ...extra };
}

describe("stripe adapter", () => {
  it("encodes nested forms like Stripe expects", () => {
    expect(encodeForm({ a: 1, recurring: { interval: "month" }, list: ["x"], skip: undefined })).toBe(
      "a=1&recurring%5Binterval%5D=month&list%5B0%5D=x",
    );
  });

  it("throws a clear error without a secret key", async () => {
    const { graph, node, routes } = setup();
    const { fetch } = fakeFetch(routes);
    await expect(stripeAdapter.audit(node, ctx(graph, fetch, { env: {} }))).rejects.toBeInstanceOf(MissingCredentialsError);
    await expect(stripeAdapter.audit(node, ctx(graph, fetch, { env: { MY_KEY: "k" }, settings: { secretEnv: "MY_KEY" } }))).resolves.toBeDefined();
  });

  it("audits amounts per currency and the product name", async () => {
    const { graph, node, routes } = setup();
    const { fetch, calls } = fakeFetch(routes);
    const diffs = await stripeAdapter.audit(node, ctx(graph, fetch));
    expect(calls[0]).toMatchObject({ method: "GET", auth: "Bearer sk_test_123" });
    expect(diffs).toEqual([
      expect.objectContaining({ kind: "mismatch", fact: "addon:pro.price.eur", field: "currency_options.eur.unit_amount", expected: 5.49, actual: 4.99 }),
      expect.objectContaining({ kind: "mismatch", fact: "addon:pro.price.usd", field: "unit_amount", expected: 5.99, actual: 4.99 }),
      expect.objectContaining({ kind: "mismatch", fact: "addon:pro.name", expected: "Pro Max", actual: "Pro+" }),
    ]);
  });

  it("flags archived and missing prices as breaks", async () => {
    const archived = setup({ active: false, unit_amount: 599, currency_options: undefined }, "Pro Max");
    const a = fakeFetch(archived.routes);
    expect(await stripeAdapter.audit(archived.node, ctx(archived.graph, a.fetch))).toEqual([
      expect.objectContaining({ kind: "break", message: "price price_old is archived" }),
    ]);
    const gone = setup();
    const g = fakeFetch([]);
    expect(await stripeAdapter.audit(gone.node, ctx(gone.graph, g.fetch))).toEqual([
      expect.objectContaining({ kind: "break", message: "price price_old does not exist" }),
    ]);
  });

  it("dry-runs without POSTing", async () => {
    const { graph, node, routes } = setup();
    const { fetch, calls } = fakeFetch(routes);
    const result = await stripeAdapter.apply!(node, ctx(graph, fetch, { dryRun: true }));
    expect(result.ok).toBe(true);
    expect(result.changes.every((c) => c.startsWith("would "))).toBe(true);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("applies by creating a new price, archiving the old one, and renaming; then reverts", async () => {
    const { graph, node, routes } = setup();
    const posts: Route = (c) => {
      if (c.method !== "POST") return undefined;
      if (c.url === `${API}/prices`) return { json: { ...basePrice, id: "price_new", unit_amount: 599 } };
      return { json: {} };
    };
    const { fetch, calls } = fakeFetch([...routes, posts]);
    const result = await stripeAdapter.apply!(node, ctx(graph, fetch));
    expect(result.ok).toBe(true);
    expect(result.bindingUpdate).toEqual({ price: "price_new" });
    expect(result.changes).toContain("newPrice: price_new");
    expect(result.undo?.data).toMatchObject({ oldPrice: "price_old", newPrice: "price_new", lookupKey: "pro_monthly", productId: "prod_pro", oldName: "Pro+" });

    const postCalls = calls.filter((c) => c.method === "POST");
    expect(postCalls.map((c) => c.url)).toEqual([`${API}/prices`, `${API}/prices/price_old`, `${API}/products/prod_pro`]);
    const created = new URLSearchParams(postCalls[0]!.body);
    expect(Object.fromEntries(created)).toEqual({
      product: "prod_pro",
      currency: "usd",
      unit_amount: "599",
      nickname: "Pro monthly",
      tax_behavior: "exclusive",
      "recurring[interval]": "month",
      "recurring[interval_count]": "1",
      "recurring[usage_type]": "licensed",
      lookup_key: "pro_monthly",
      transfer_lookup_key: "true",
      "currency_options[eur][unit_amount]": "549",
      "currency_options[eur][tax_behavior]": "exclusive",
      "metadata[tier]": "pro",
    });
    expect(postCalls[1]!.body).toBe("active=false");
    expect(postCalls[2]!.body).toBe("name=Pro%20Max");

    const revertFetch = fakeFetch([() => ({ json: {} })]);
    const reverted = await stripeAdapter.revert!(result.undo!, ctx(graph, revertFetch.fetch));
    expect(reverted).toMatchObject({ ok: true, bindingUpdate: { price: "price_old" } });
    expect(revertFetch.calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", `${API}/prices/price_old`, "active=true&lookup_key=pro_monthly&transfer_lookup_key=true"],
      ["POST", `${API}/prices/price_new`, "active=false"],
      ["POST", `${API}/products/prod_pro`, "name=Pro%2B"],
    ]);
  });

  it("refuses to write when disabled", async () => {
    const { graph, node, routes } = setup();
    const { fetch, calls } = fakeFetch(routes);
    const result = await stripeAdapter.apply!(node, ctx(graph, fetch, { settings: { write: false } }));
    expect(result).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it("lists active prices across pages", async () => {
    const page = (ids: string[], hasMore: boolean) => ({ data: ids.map((id) => ({ ...basePrice, id })), has_more: hasMore });
    const { fetch, calls } = fakeFetch([
      (c) => (c.url === `${API}/prices?limit=100&active=true` ? { json: page(["price_a", "price_b"], true) } : undefined),
      (c) => (c.url === `${API}/prices?limit=100&active=true&starting_after=price_b` ? { json: page(["price_c"], false) } : undefined),
    ]);
    const graph = new Graph();
    const listed = await stripeAdapter.list!(ctx(graph, fetch));
    expect(calls).toHaveLength(2);
    expect(listed.map((l) => l.externalId)).toEqual(["price_a", "price_b", "price_c"]);
    expect(listed[0]).toEqual({ externalId: "price_a", label: "Pro monthly 4.99 USD/month", binding: { adapter: "stripe", price: "price_a" }, active: true });
  });
});
