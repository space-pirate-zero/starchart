import type { Graph } from "../core/graph.js";
import type { GraphNode } from "../core/model.js";
import { MissingCredentialsError } from "./errors.js";
import { leafFacts } from "./text.js";
import type { Adapter, AdapterContext, ApplyResult, Diff, ListedResource, UndoRecord } from "./types.js";

/**
 * Stripe prices and products.
 *
 * binding: { adapter: stripe, price?: "price_...", product?: "prod_..." }
 * settings (adapters.stripe): { secretEnv?: "STRIPE_SECRET_KEY", write?: boolean }
 *
 * Mirrored facts are matched by id: a leaf ending in a currency code (addon:pro.price.usd), a
 * container of currency leaves (addon:pro.price = {usd, eur}), a leaf ending in ".price"/".amount"
 * (the price's own currency), and a leaf ending in ".name" (the product name).
 *
 * Stripe prices are immutable: apply creates a replacement price (copying product, recurring,
 * lookup key, tax behavior, currency options and metadata), archives the old one, and reports
 * the new id via `bindingUpdate` so the engine can rewrite the YAML binding.
 */

const API = "https://api.stripe.com/v1";

const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
const CURRENCIES = new Set([
  "usd", "eur", "gbp", "jpy", "cad", "aud", "nzd", "chf", "sek", "nok", "dkk", "pln", "czk", "huf", "ron", "bgn",
  "try", "inr", "cny", "hkd", "sgd", "krw", "twd", "thb", "idr", "myr", "php", "vnd", "brl", "mxn", "ars", "clp",
  "cop", "pen", "zar", "ils", "aed", "sar", "qar", "egp", "ngn", "kes", "uah", "isk", "rub",
]);

export interface StripePrice {
  id: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  product: string | { id: string };
  recurring: { interval: string; interval_count?: number; usage_type?: string } | null;
  lookup_key: string | null;
  nickname: string | null;
  tax_behavior?: string | null;
  currency_options?: Record<string, { unit_amount: number | null; tax_behavior?: string | null }>;
  metadata?: Record<string, string>;
}

export interface StripeProduct {
  id: string;
  name: string;
  active: boolean;
}

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

type FormValue = string | number | boolean | null | undefined | FormObject | FormValue[];
interface FormObject {
  [key: string]: FormValue;
}

/** Stripe's bracketed form encoding: {recurring: {interval: "month"}} → recurring[interval]=month. */
export function encodeForm(data: FormObject): string {
  const pairs: string[] = [];
  const walk = (prefix: string, value: FormValue) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}[${k}]` : k, v);
    else pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };
  walk("", data);
  return pairs.join("&");
}

export function stripeKey(ctx: AdapterContext): string {
  const envName = typeof ctx.settings.secretEnv === "string" && ctx.settings.secretEnv ? ctx.settings.secretEnv : "STRIPE_SECRET_KEY";
  const key = ctx.env[envName];
  if (!key) throw new MissingCredentialsError("stripe", `Stripe secret key not found: set the ${envName} environment variable`);
  return key;
}

export class StripeClient {
  constructor(
    private readonly key: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async request<T>(method: "GET" | "POST", path: string, body?: FormObject): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${this.key}`,
        ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
    };
    if (body) init.body = encodeForm(body);
    const res = await this.fetchImpl(`${API}${path}`, init);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      const message = (json as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
      throw new StripeApiError(res.status, `Stripe ${method} ${path}: ${message}`);
    }
    return json as T;
  }

  getPrice(id: string): Promise<StripePrice> {
    return this.request("GET", `/prices/${encodeURIComponent(id)}?expand%5B%5D=currency_options`);
  }

  getProduct(id: string): Promise<StripeProduct> {
    return this.request("GET", `/products/${encodeURIComponent(id)}`);
  }
}

const toMinor = (amount: number, currency: string) => Math.round(ZERO_DECIMAL.has(currency) ? amount : amount * 100);
const fromMinor = (minor: number, currency: string) => (ZERO_DECIMAL.has(currency) ? minor : minor / 100);
const fmt = (minor: number | null | undefined, currency: string) =>
  minor === null || minor === undefined ? "n/a" : `${fromMinor(minor, currency)} ${currency.toUpperCase()}`;
const productIdOf = (p: StripePrice) => (typeof p.product === "string" ? p.product : p.product.id);
const lastSegment = (id: string) => id.slice(id.lastIndexOf(".") + 1);

interface AmountExpectation {
  fact: string;
  /** Lowercase currency, or undefined for "the price's own currency". */
  currency?: string;
  amount: number;
  /** A directly mirrored single-currency leaf: a currency the price lacks is a mismatch, not noise. */
  explicit: boolean;
}

export function mirroredExpectations(graph: Graph, artifactId: string): { amounts: AmountExpectation[]; name?: { fact: string; value: string } } {
  const direct = new Set(graph.outgoing(artifactId, "mirrors").map((e) => e.to));
  const amounts: AmountExpectation[] = [];
  let name: { fact: string; value: string } | undefined;
  for (const leaf of leafFacts(graph, artifactId, ["mirrors"])) {
    const seg = lastSegment(leaf.id).toLowerCase();
    if (typeof leaf.value === "number") {
      if (CURRENCIES.has(seg)) amounts.push({ fact: leaf.id, currency: seg, amount: leaf.value, explicit: direct.has(leaf.id) });
      else if (seg === "price" || seg === "amount") amounts.push({ fact: leaf.id, amount: leaf.value, explicit: true });
    } else if (seg === "name" && typeof leaf.value === "string" && !name) {
      name = { fact: leaf.id, value: leaf.value };
    }
  }
  return { amounts, name };
}

interface PriceDelta {
  fact: string;
  currency: string;
  expected: number;
  actual: number | null;
  /** Where on the price the amount lives. */
  field: string;
}

function priceDeltas(price: StripePrice, amounts: AmountExpectation[]): { deltas: PriceDelta[]; foreign: AmountExpectation[] } {
  const deltas: PriceDelta[] = [];
  const foreign: AmountExpectation[] = [];
  for (const a of amounts) {
    const currency = a.currency ?? price.currency;
    const expected = toMinor(a.amount, currency);
    if (currency === price.currency) {
      if (price.unit_amount !== expected) deltas.push({ fact: a.fact, currency, expected, actual: price.unit_amount, field: "unit_amount" });
      continue;
    }
    const option = price.currency_options?.[currency];
    if (option) {
      if (option.unit_amount !== expected) {
        deltas.push({ fact: a.fact, currency, expected, actual: option.unit_amount, field: `currency_options.${currency}.unit_amount` });
      }
    } else if (a.explicit) foreign.push(a);
  }
  return { deltas, foreign };
}

function isNotFound(e: unknown): boolean {
  return e instanceof StripeApiError && e.status === 404;
}

function bindingIds(node: GraphNode): { price?: string; product?: string } {
  const price = typeof node.binding?.price === "string" ? node.binding.price : undefined;
  const product = typeof node.binding?.product === "string" ? node.binding.product : undefined;
  if (!price && !product) throw new Error(`${node.id}: stripe binding needs "price" or "product"`);
  return { price, product };
}

/** Existence/activity of one price, for break detection. */
export async function checkPrice(priceId: string, ctx: AdapterContext): Promise<{ exists: boolean; active: boolean }> {
  const client = new StripeClient(stripeKey(ctx), ctx.fetch);
  try {
    const price = await client.getPrice(priceId);
    return { exists: true, active: price.active };
  } catch (e) {
    if (isNotFound(e)) return { exists: false, active: false };
    throw e;
  }
}

async function audit(node: GraphNode, ctx: AdapterContext): Promise<Diff[]> {
  const client = new StripeClient(stripeKey(ctx), ctx.fetch);
  const ids = bindingIds(node);
  const { amounts, name } = mirroredExpectations(ctx.graph, node.id);
  const diffs: Diff[] = [];
  let productId = ids.product;

  if (ids.price) {
    const where = `stripe:price/${ids.price}`;
    let price: StripePrice;
    try {
      price = await client.getPrice(ids.price);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      return [{ artifact: node.id, kind: "break", message: `price ${ids.price} does not exist`, where }];
    }
    if (!price.active) diffs.push({ artifact: node.id, kind: "break", message: `price ${ids.price} is archived`, where });
    const { deltas, foreign } = priceDeltas(price, amounts);
    for (const d of deltas) {
      diffs.push({
        artifact: node.id,
        fact: d.fact,
        field: d.field,
        kind: "mismatch",
        expected: fromMinor(d.expected, d.currency),
        actual: d.actual === null ? null : fromMinor(d.actual, d.currency),
        message: `Stripe has ${fmt(d.actual, d.currency)}, fact says ${fmt(d.expected, d.currency)}`,
        where,
      });
    }
    for (const f of foreign) {
      diffs.push({
        artifact: node.id,
        fact: f.fact,
        field: "currency",
        kind: "mismatch",
        expected: f.currency,
        actual: price.currency,
        message: `price ${ids.price} has no ${f.currency?.toUpperCase()} amount (price currency is ${price.currency.toUpperCase()})`,
        where,
      });
    }
    productId ??= productIdOf(price);
  }

  if (productId && (name || !ids.price)) {
    const where = `stripe:product/${productId}`;
    let product: StripeProduct;
    try {
      product = await client.getProduct(productId);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      diffs.push({ artifact: node.id, kind: "break", message: `product ${productId} does not exist`, where });
      return diffs;
    }
    if (!product.active) diffs.push({ artifact: node.id, kind: "break", message: `product ${productId} is archived`, where });
    if (name && product.name !== name.value) {
      diffs.push({
        artifact: node.id,
        fact: name.fact,
        field: "name",
        kind: "mismatch",
        expected: name.value,
        actual: product.name,
        message: `product name is "${product.name}", fact says "${name.value}"`,
        where,
      });
    }
  }
  return diffs;
}

function newPriceForm(price: StripePrice, deltas: PriceDelta[]): FormObject {
  const byCurrency = new Map(deltas.map((d) => [d.currency, d.expected]));
  const form: FormObject = {
    product: productIdOf(price),
    currency: price.currency,
    unit_amount: byCurrency.get(price.currency) ?? price.unit_amount,
  };
  if (price.nickname) form.nickname = price.nickname;
  if (price.tax_behavior) form.tax_behavior = price.tax_behavior;
  if (price.recurring) {
    const recurring: FormObject = { interval: price.recurring.interval };
    if (price.recurring.interval_count) recurring.interval_count = price.recurring.interval_count;
    if (price.recurring.usage_type) recurring.usage_type = price.recurring.usage_type;
    form.recurring = recurring;
  }
  if (price.lookup_key) {
    form.lookup_key = price.lookup_key;
    form.transfer_lookup_key = true;
  }
  const options: FormObject = {};
  for (const [currency, option] of Object.entries(price.currency_options ?? {})) {
    if (currency === price.currency) continue;
    const entry: FormObject = { unit_amount: byCurrency.get(currency) ?? option.unit_amount };
    if (option.tax_behavior) entry.tax_behavior = option.tax_behavior;
    options[currency] = entry;
  }
  if (Object.keys(options).length) form.currency_options = options;
  if (price.metadata && Object.keys(price.metadata).length) form.metadata = { ...price.metadata };
  return form;
}

async function apply(node: GraphNode, ctx: AdapterContext): Promise<ApplyResult> {
  if (ctx.settings.write === false) {
    return { artifact: node.id, ok: false, changes: [], error: "writes to Stripe are disabled (adapters.stripe.write: false)" };
  }
  const client = new StripeClient(stripeKey(ctx), ctx.fetch);
  const ids = bindingIds(node);
  const { amounts, name } = mirroredExpectations(ctx.graph, node.id);

  let price: StripePrice | undefined;
  let deltas: PriceDelta[] = [];
  if (ids.price) {
    price = await client.getPrice(ids.price);
    const result = priceDeltas(price, amounts);
    deltas = result.deltas;
    if (result.foreign.length > 0) {
      const f = result.foreign[0]!;
      return {
        artifact: node.id,
        ok: false,
        changes: [],
        error: `${f.fact} is ${f.currency?.toUpperCase()} but price ${ids.price} is ${price.currency.toUpperCase()}; bind a matching price`,
      };
    }
  }
  const productId = ids.product ?? (price ? productIdOf(price) : undefined);
  let product: StripeProduct | undefined;
  if (name && productId) product = await client.getProduct(productId);
  const rename = name && product && product.name !== name.value ? { from: product.name, to: name.value } : undefined;

  if (deltas.length === 0 && !rename) return { artifact: node.id, ok: true, changes: [] };

  const plannedPrice = deltas.map((d) => `${d.fact}: ${fmt(d.actual, d.currency)} → ${fmt(d.expected, d.currency)}`);
  if (ctx.dryRun) {
    const changes = [...plannedPrice.map((c) => `would create a replacement price (${c}) and archive ${ids.price}`)];
    if (rename) changes.push(`would rename product ${productId}: "${rename.from}" → "${rename.to}"`);
    return { artifact: node.id, ok: true, changes };
  }

  const changes: string[] = [];
  const data: Record<string, unknown> = {};
  const undo: UndoRecord = { adapter: "stripe", artifact: node.id, data };
  let bindingUpdate: Record<string, unknown> | undefined;
  try {
    if (price && deltas.length > 0) {
      const created = await client.request<StripePrice>("POST", "/prices", newPriceForm(price, deltas));
      data.oldPrice = price.id;
      data.newPrice = created.id;
      if (price.lookup_key) data.lookupKey = price.lookup_key;
      bindingUpdate = { price: created.id };
      changes.push(`created price ${created.id} (${plannedPrice.join("; ")})`);
      await client.request("POST", `/prices/${encodeURIComponent(price.id)}`, { active: false });
      changes.push(`archived price ${price.id}`);
      changes.push(`newPrice: ${created.id}`);
    }
    if (rename && productId) {
      await client.request("POST", `/products/${encodeURIComponent(productId)}`, { name: rename.to });
      data.productId = productId;
      data.oldName = rename.from;
      data.newName = rename.to;
      changes.push(`renamed product ${productId}: "${rename.from}" → "${rename.to}"`);
    }
  } catch (e) {
    return {
      artifact: node.id,
      ok: false,
      changes,
      error: (e as Error).message,
      undo: Object.keys(data).length ? undo : undefined,
      bindingUpdate,
    };
  }
  return { artifact: node.id, ok: true, changes, undo, bindingUpdate };
}

async function revert(undo: UndoRecord, ctx: AdapterContext): Promise<ApplyResult> {
  const { oldPrice, newPrice, lookupKey, productId, oldName } = undo.data;
  const changes: string[] = [];
  const planned: string[] = [];
  if (typeof oldPrice === "string" && typeof newPrice === "string") planned.push(`reactivate ${oldPrice}, archive ${newPrice}`);
  if (typeof productId === "string" && typeof oldName === "string") planned.push(`rename product ${productId} back to "${oldName}"`);
  if (ctx.dryRun) return { artifact: undo.artifact, ok: true, changes: planned.map((p) => `would ${p}`) };

  const client = new StripeClient(stripeKey(ctx), ctx.fetch);
  let bindingUpdate: Record<string, unknown> | undefined;
  try {
    if (typeof oldPrice === "string" && typeof newPrice === "string") {
      const body: FormObject = { active: true };
      if (typeof lookupKey === "string") {
        body.lookup_key = lookupKey;
        body.transfer_lookup_key = true;
      }
      await client.request("POST", `/prices/${encodeURIComponent(oldPrice)}`, body);
      changes.push(`reactivated price ${oldPrice}`);
      await client.request("POST", `/prices/${encodeURIComponent(newPrice)}`, { active: false });
      changes.push(`archived price ${newPrice}`);
      bindingUpdate = { price: oldPrice };
    }
    if (typeof productId === "string" && typeof oldName === "string") {
      await client.request("POST", `/products/${encodeURIComponent(productId)}`, { name: oldName });
      changes.push(`renamed product ${productId} back to "${oldName}"`);
    }
  } catch (e) {
    return { artifact: undo.artifact, ok: false, changes, error: (e as Error).message, bindingUpdate };
  }
  return { artifact: undo.artifact, ok: true, changes, bindingUpdate };
}

async function list(ctx: AdapterContext): Promise<ListedResource[]> {
  const client = new StripeClient(stripeKey(ctx), ctx.fetch);
  const out: ListedResource[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const query = encodeForm({ limit: 100, active: true, starting_after: startingAfter });
    const page = await client.request<{ data: StripePrice[]; has_more: boolean }>("GET", `/prices?${query}`);
    for (const p of page.data) {
      const interval = p.recurring ? `/${p.recurring.interval_count && p.recurring.interval_count > 1 ? `${p.recurring.interval_count} ` : ""}${p.recurring.interval}` : "";
      out.push({
        externalId: p.id,
        label: `${p.nickname ?? p.lookup_key ?? productIdOf(p)} ${fmt(p.unit_amount, p.currency)}${interval}`,
        binding: { adapter: "stripe", price: p.id },
        active: p.active,
      });
    }
    const last = page.data[page.data.length - 1];
    if (!page.has_more || !last) break;
    startingAfter = last.id;
  }
  return out;
}

export const stripeAdapter: Adapter = {
  id: "stripe",
  capabilities: { read: true, write: true, dryRun: true, rollback: true, list: true },
  audit,
  apply,
  revert,
  list,
};
