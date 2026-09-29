import type { Graph } from "../core/graph.js";
import { EDGE_TYPES, type GraphNode } from "../core/model.js";

/**
 * JSON-LD export of the graph (interchange format), plus clean schema.org markup for a single
 * entity (SEO structured data).
 */

export const SC_VOCAB = "https://starchart.spacepiratezero.com/vocab#";

export type JsonLd = Record<string, unknown>;

/** The STARCHART JSON-LD @context: schema.org as the default vocabulary, `sc:` for bridge/code terms. */
export function jsonLdContext(): JsonLd {
  const context: JsonLd = {
    "@version": 1.1,
    "@vocab": "https://schema.org/",
    schema: "https://schema.org/",
    sc: SC_VOCAB,
  };
  for (const type of EDGE_TYPES) context[`sc:${type}`] = { "@id": `sc:${type}`, "@type": "@id" };
  return context;
}

export interface ToJsonLdOptions {
  /** Only export these node ids (default: every fact- and world-layer node). */
  ids?: string[];
  /** Include code-layer nodes (and edges pointing at them). */
  includeCode?: boolean;
}

/** Exports the graph as a JSON-LD document with one node object per graph node. */
export function toJsonLd(graph: Graph, opts: ToJsonLdOptions = {}): JsonLd {
  const includeCode = opts.includeCode ?? false;
  const wanted = opts.ids ? new Set(opts.ids) : undefined;
  const nodes = graph
    .nodes()
    .filter((n) => (wanted ? wanted.has(n.id) : includeCode || n.layer !== "code"))
    .sort((a, b) => a.id.localeCompare(b.id));

  const entries = nodes.map((node) => {
    const obj = nodeObject(node);
    const byType = new Map<string, string[]>();
    for (const edge of graph.outgoing(node.id)) {
      const target = graph.node(edge.to);
      if (!includeCode && target?.layer === "code") continue;
      const list = byType.get(edge.type) ?? [];
      list.push(edge.to);
      byType.set(edge.type, list);
    }
    for (const type of [...byType.keys()].sort()) {
      const targets = byType.get(type)!.sort();
      obj[`sc:${type}`] = targets.length === 1 ? targets[0] : targets;
    }
    return obj;
  });
  return { "@context": jsonLdContext(), "@graph": entries };
}

function nodeObject(node: GraphNode): JsonLd {
  const obj: JsonLd = {
    "@id": node.id,
    "@type": node.types && node.types.length ? (node.types.length === 1 ? node.types[0] : [...node.types]) : `sc:${capitalize(node.kind)}`,
    "sc:layer": node.layer,
    "sc:kind": node.kind,
  };
  if (node.label) obj.name = node.label;
  if (node.value !== undefined) obj["sc:value"] = jsonValue(node.value);
  if (node.authority) obj["sc:authority"] = node.authority;
  if (node.status) obj["sc:status"] = node.status;
  if (node.validThrough) obj.validThrough = node.validThrough;
  if (node.owners?.length) obj["sc:owner"] = [...node.owners];
  if (node.tags?.length) obj.keywords = [...node.tags];
  if (node.binding) obj["sc:binding"] = jsonValue(node.binding);
  if (node.location) obj["sc:location"] = node.location.line ? `${node.location.file}:${node.location.line}` : node.location.file;
  if (node.hash) obj["sc:hash"] = node.hash;
  return obj;
}

/** Scalars stay plain literals; structured values become JSON literals so they are not read as nodes. */
function jsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  return { "@type": "@json", "@value": value };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── schema.org for SEO ────────────────────────────────────────────────────────

const SCHEMA_CONTEXT = "https://schema.org";

/** Facts of an entity as a nested plain object (`{ name, price: { usd } }`). */
export function entityFacts(graph: Graph, entityId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const edge of graph.incoming(entityId, "partOf")) {
    const child = graph.node(edge.from);
    if (child?.kind !== "fact" || !child.id.startsWith(`${entityId}.`)) continue;
    const key = child.id.slice(entityId.length + 1);
    out[key] = factValue(graph, child.id);
  }
  return out;
}

function factValue(graph: Graph, id: string): unknown {
  const children = graph.incoming(id, "partOf").filter((e) => graph.node(e.from)?.kind === "fact");
  if (children.length === 0) return graph.node(id)?.value;
  const value: Record<string, unknown> = {};
  for (const c of children) value[c.from.slice(id.length + 1)] = factValue(graph, c.from);
  return value;
}

function schemaTypes(node: GraphNode): string[] {
  return (node.types ?? [])
    .map((t) => (t.startsWith("schema:") ? t.slice(7) : t.startsWith("https://schema.org/") ? t.slice(19) : undefined))
    .filter((t): t is string => Boolean(t));
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const list = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) {
    const items = v.map(str).filter((x): x is string => Boolean(x));
    return items.length ? items : undefined;
  }
  const s = str(v);
  return s ? [s] : undefined;
};

/** First defined value among candidate keys. */
function pick(facts: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (facts[k] !== undefined && facts[k] !== null) return facts[k];
  return undefined;
}

/** Common descriptive properties shared by every schema.org type we emit. */
function describe(node: GraphNode, facts: Record<string, unknown>): JsonLd {
  const out: JsonLd = {};
  const name = str(pick(facts, "name", "title")) ?? node.label;
  if (name) out.name = name;
  const description = str(pick(facts, "description", "tagline", "summary"));
  if (description) out.description = description;
  const image = list(pick(facts, "image", "images", "icon", "logo"));
  if (image) out.image = image.length === 1 ? image[0] : image;
  const url = str(pick(facts, "url", "link", "website"));
  if (url) out.url = url;
  return out;
}

function availability(node: GraphNode, facts: Record<string, unknown>): string | undefined {
  const status = str(pick(facts, "status")) ?? node.status;
  if (!status) return undefined;
  switch (status.toLowerCase()) {
    case "active":
    case "live":
    case "available":
      return "https://schema.org/InStock";
    case "preorder":
    case "coming-soon":
    case "upcoming":
      return "https://schema.org/PreOrder";
    case "retired":
    case "discontinued":
    case "archived":
      return "https://schema.org/Discontinued";
    default:
      return undefined;
  }
}

const formatPrice = (n: number) => n.toFixed(2);

/** One Offer per currency. `price` may be a number (with `currency`/`priceCurrency`) or `{ usd: 5.99, eur: 5.49 }`. */
function offersFor(graph: Graph, node: GraphNode, facts: Record<string, unknown>, withContext: boolean): JsonLd[] {
  const rawPrice = pick(facts, "price", "prices");
  const prices: [string, number][] = [];
  const single = num(rawPrice);
  if (single !== undefined) {
    const currency = str(pick(facts, "priceCurrency", "currency")) ?? "USD";
    prices.push([currency.toUpperCase(), single]);
  } else if (rawPrice && typeof rawPrice === "object" && !Array.isArray(rawPrice)) {
    const obj = rawPrice as Record<string, unknown>;
    const amount = num(obj.amount ?? obj.value);
    const cur = str(obj.currency);
    if (amount !== undefined && cur) prices.push([cur.toUpperCase(), amount]);
    else {
      for (const [currency, value] of Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))) {
        const n = num(value);
        if (n !== undefined && /^[a-z]{3}$/i.test(currency)) prices.push([currency.toUpperCase(), n]);
      }
    }
  }
  if (prices.length === 0) return [];

  const base: JsonLd = describe(node, facts);
  const sku = str(pick(facts, "sku", "productId"));
  if (sku) base.sku = sku;
  const avail = availability(node, facts);
  if (avail) base.availability = avail;
  const validThrough = str(pick(facts, "validThrough")) ?? node.validThrough;
  if (validThrough) base.priceValidUntil = validThrough.slice(0, 10);
  if (validThrough) base.validThrough = validThrough;
  const seller = str(pick(facts, "seller", "brand"));
  if (seller) base.seller = { "@type": "Organization", name: seller };

  return prices.map(([currency, amount]) => ({
    ...(withContext ? { "@context": SCHEMA_CONTEXT } : {}),
    "@type": "Offer",
    ...base,
    price: formatPrice(amount),
    priceCurrency: currency,
  }));
}

/** Entities that declare `of: <entityId>` (partOf) — add-ons and plans of an app. */
function partsOf(graph: Graph, entityId: string): GraphNode[] {
  return graph
    .incoming(entityId, "partOf")
    .map((e) => graph.node(e.from))
    .filter((n): n is GraphNode => n?.kind === "entity")
    .sort((a, b) => a.id.localeCompare(b.id));
}

function aggregateRating(facts: Record<string, unknown>): JsonLd | undefined {
  const nested = pick(facts, "aggregateRating");
  const source = nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : facts;
  const ratingValue = num(pick(source, "rating", "ratingValue"));
  const ratingCount = num(pick(source, "ratingCount", "reviewCount", "ratings"));
  if (ratingValue === undefined || ratingCount === undefined || ratingCount <= 0) return undefined;
  const out: JsonLd = { "@type": "AggregateRating", ratingValue: String(ratingValue), ratingCount: String(Math.round(ratingCount)) };
  const best = num(pick(source, "bestRating"));
  if (best !== undefined) out.bestRating = String(best);
  return out;
}

function softwareApplication(graph: Graph, node: GraphNode, facts: Record<string, unknown>): JsonLd {
  const out: JsonLd = { "@context": SCHEMA_CONTEXT, "@type": "SoftwareApplication", ...describe(node, facts) };
  const category = str(pick(facts, "applicationCategory", "category"));
  if (category) out.applicationCategory = category;
  const os = list(pick(facts, "operatingSystem", "os", "platforms", "platform"));
  if (os) out.operatingSystem = os.join(", ");
  const version = str(pick(facts, "softwareVersion", "version"));
  if (version) out.softwareVersion = version;
  const offers = [...offersFor(graph, node, facts, false)];
  for (const part of partsOf(graph, node.id)) offers.push(...offersFor(graph, part, entityFacts(graph, part.id), false));
  if (offers.length) out.offers = offers;
  const rating = aggregateRating(facts);
  if (rating) out.aggregateRating = rating;
  return out;
}

function faqPage(node: GraphNode, facts: Record<string, unknown>): JsonLd {
  const raw = pick(facts, "questions", "faq", "faqs");
  const questions = Array.isArray(raw) ? raw : [];
  const mainEntity = questions
    .map((q) => {
      if (!q || typeof q !== "object") return undefined;
      const item = q as Record<string, unknown>;
      const name = str(item.q ?? item.question ?? item.name);
      const text = str(item.a ?? item.answer ?? item.text);
      if (!name || !text) return undefined;
      return { "@type": "Question", name, acceptedAnswer: { "@type": "Answer", text } };
    })
    .filter(Boolean);
  const out: JsonLd = { "@context": SCHEMA_CONTEXT, "@type": "FAQPage", ...describe(node, facts) };
  out.mainEntity = mainEntity;
  return out;
}

function genericThing(graph: Graph, node: GraphNode, facts: Record<string, unknown>, type: string): JsonLd {
  const out: JsonLd = { "@context": SCHEMA_CONTEXT, "@type": type, ...describe(node, facts) };
  const sku = str(pick(facts, "sku", "productId"));
  if (sku && type === "Product") out.sku = sku;
  const brand = str(pick(facts, "brand"));
  if (brand) out.brand = { "@type": "Brand", name: brand };
  const offers = offersFor(graph, node, facts, false);
  if (offers.length) out.offers = offers.length === 1 ? offers[0] : offers;
  const rating = aggregateRating(facts);
  if (rating) out.aggregateRating = rating;
  return out;
}

/**
 * Clean, publishable schema.org markup for one entity. `schema:Offer` with several currencies
 * yields an array of Offers (one per currency); other types yield a single object.
 */
export function schemaOrgFor(graph: Graph, entityId: string): JsonLd | JsonLd[] {
  const node = graph.node(entityId);
  if (!node) throw new Error(`unknown node "${entityId}"`);
  const facts = entityFacts(graph, entityId);
  const types = schemaTypes(node);

  if (types.includes("Offer")) {
    const offers = offersFor(graph, node, facts, true);
    if (offers.length === 0) {
      return { "@context": SCHEMA_CONTEXT, "@type": "Offer", ...describe(node, facts) };
    }
    return offers.length === 1 ? offers[0]! : offers;
  }
  if (types.includes("SoftwareApplication") || types.includes("MobileApplication") || types.includes("WebApplication")) {
    const out = softwareApplication(graph, node, facts);
    if (!types.includes("SoftwareApplication")) out["@type"] = types.find((t) => t.endsWith("Application"));
    return out;
  }
  if (types.includes("FAQPage")) return faqPage(node, facts);
  return genericThing(graph, node, facts, types[0] ?? "Product");
}

/** `<script type="application/ld+json">` block, safe to inline in HTML. */
export function jsonLdScriptTag(obj: unknown): string {
  const json = JSON.stringify(obj, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script type="application/ld+json">${json}</script>`;
}
