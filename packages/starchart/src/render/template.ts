import type { Graph } from "../core/graph.js";

/**
 * A tiny, strict template engine for fact-driven renders (OG images, JSON-LD, copy blocks).
 *
 *   {{ fact:addon:pro.price.usd | money:USD }}   {{ addon:pro.name | upper }}
 *   {{ addon:pro.features | join:", " }}          {{ campaign:x.tagline | default:"Go Pro" }}
 *
 * Expressions resolve against `extra` first, then any graph node's value by id (the "fact:"
 * prefix is optional). An unknown reference without a `default` filter throws.
 */

export interface RenderOptions {
  /** "xml" escapes every substituted value for .svg / .html / .xml output. */
  escape?: "xml" | "none";
  /** Template name used in error messages. */
  name?: string;
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** Escape mode implied by a file name. */
export function escapeFor(path: string): "xml" | "none" {
  return /\.(svg|html?|xml)$/i.test(path) ? "xml" : "none";
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Filter {
  name: string;
  arg?: string;
}

const EXPR = /\{\{\s*([\s\S]*?)\s*\}\}/g;

export function renderTemplate(
  source: string,
  graph: Graph,
  extra: Record<string, unknown> = {},
  options: RenderOptions = {},
): string {
  const label = options.name ?? "template";
  return source.replace(EXPR, (_whole, expr: string) => {
    const [ref, ...filterSources] = splitPipes(expr);
    const key = (ref ?? "").trim();
    if (!key) throw new TemplateError(`${label}: empty expression "{{${expr}}}"`);
    const filters = filterSources.map(parseFilter);
    let value = resolve(key, graph, extra);
    const fallback = filters.find((f) => f.name === "default");
    if (value === undefined || value === null) {
      if (!fallback) throw new TemplateError(`${label}: unknown fact "${key.replace(/^fact:/, "")}"`);
      value = fallback.arg ?? "";
    }
    for (const f of filters) value = applyFilter(value, f, label);
    const text = stringify(value);
    return options.escape === "xml" ? xmlEscape(text) : text;
  });
}

function resolve(key: string, graph: Graph, extra: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(extra, key)) return extra[key];
  const id = key.startsWith("fact:") ? key.slice("fact:".length) : key;
  if (Object.prototype.hasOwnProperty.call(extra, id)) return extra[id];
  return graph.node(id)?.value;
}

/** Splits on "|" outside of quotes. */
function splitPipes(expr: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const ch of expr) {
    if (quote) {
      if (ch === quote) quote = undefined;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "|") {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

function parseFilter(source: string): Filter {
  const trimmed = source.trim();
  const colon = trimmed.indexOf(":");
  if (colon < 0) return { name: trimmed };
  const name = trimmed.slice(0, colon).trim();
  let arg = trimmed.slice(colon + 1).trim();
  const q = arg[0];
  if ((q === '"' || q === "'") && arg.endsWith(q) && arg.length >= 2) arg = arg.slice(1, -1);
  return { name, arg };
}

function applyFilter(value: unknown, filter: Filter, label: string): unknown {
  switch (filter.name) {
    case "default":
      return value;
    case "upper":
      return stringify(value).toUpperCase();
    case "lower":
      return stringify(value).toLowerCase();
    case "join":
      return Array.isArray(value) ? value.map(stringify).join(filter.arg ?? ", ") : value;
    case "money":
      return formatMoney(value, filter.arg ?? "USD", label);
    default:
      throw new TemplateError(`${label}: unknown filter "${filter.name}"`);
  }
}

/** "$5.99", "€5.99", "£4.99", "¥599". A {usd: 5.99} object picks the matching currency. */
export function formatMoney(value: unknown, currency: string, label = "template"): string {
  const code = currency.toUpperCase();
  let amount: unknown = value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    amount = record[code.toLowerCase()] ?? record[code];
  }
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new TemplateError(`${label}: money filter needs a number, got ${JSON.stringify(value)}`);
  }
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(n);
  } catch {
    throw new TemplateError(`${label}: unknown currency "${currency}"`);
  }
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(stringify).join(", ");
  return JSON.stringify(value);
}
