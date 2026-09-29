import type { Graph } from "../core/graph.js";
import type { GraphNode } from "../core/model.js";

/** Shared graph helpers for the rules engine, rule packs and analyses. */

const MS_PER_DAY = 86_400_000;

/** Reads a dotted path (e.g. `meta.publishedAt`, `binding.adapter`) from a node. */
export function getPath(node: GraphNode, path: string): unknown {
  let current: unknown = node;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Glob-ish id match: `*` matches any run of characters; case-insensitive when `ci`. */
export function matchPattern(pattern: string, id: string, ci = false): boolean {
  if (!pattern.includes("*")) return ci ? pattern.toLowerCase() === id.toLowerCase() : pattern === id;
  const source = pattern
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, ci ? "i" : "").test(id);
}

/** An id pattern that is either exact, or a prefix when it ends with `*`. */
export function matchIdOrPrefix(pattern: string, id: string): boolean {
  return pattern.endsWith("*") && !pattern.slice(0, -1).includes("*") ? id.startsWith(pattern.slice(0, -1)) : matchPattern(pattern, id);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Structural equality; numbers (and numeric strings compared to numbers) compare numerically. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" || typeof b === "number") {
    const na = toNumber(a);
    const nb = toNumber(b);
    if (na !== undefined && nb !== undefined) return Math.abs(na - nb) < 1e-9;
  }
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Compact human rendering of a value for messages. Long strings are truncated. */
export function formatValue(v: unknown, max = 80): string {
  if (typeof v === "string") return JSON.stringify(v.length > max ? `${v.slice(0, max - 1)}…` : v);
  if (v === undefined) return "undefined";
  const s = JSON.stringify(v) ?? String(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Character count as stores count it (Unicode code points, not UTF-16 units). */
export const charLength = (s: string): number => [...s].length;

/** A `{ locale: text }` map, e.g. localized store copy or i18n values. */
export function isLocaleMap(v: unknown): v is Record<string, string | number> {
  if (!isPlainObject(v)) return false;
  const values = Object.values(v);
  return values.length > 0 && values.every((x) => typeof x === "string" || typeof x === "number");
}

/** Parses a date-ish value; undefined when absent or invalid. */
export function parseDate(v: unknown): number | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.getTime();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

export const ageInDays = (t: number, now: Date): number => Math.floor((now.getTime() - t) / MS_PER_DAY);

/**
 * validThrough is a date (inclusive) or a timestamp. A bare date stays valid for that whole day.
 */
export function isExpired(node: GraphNode, now: Date): boolean {
  if (!node.validThrough) return false;
  const t = parseDate(node.validThrough);
  if (t === undefined) return false;
  const endOfDay = /^\d{4}-\d{2}-\d{2}$/.test(node.validThrough) ? t + MS_PER_DAY - 1 : t;
  return endOfDay < now.getTime();
}

/** Child facts (direct `partOf` sources that are facts). */
export function childFacts(graph: Graph, id: string): string[] {
  return graph
    .incoming(id, "partOf")
    .filter((e) => graph.node(e.from)?.kind === "fact")
    .map((e) => e.from);
}

/** Every fact under an entity or container fact, depth first. */
export function descendantFacts(graph: Graph, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    const current = stack.pop()!;
    for (const child of childFacts(graph, current)) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      stack.push(child);
    }
  }
  return out.sort();
}

/** Parents reached through `partOf` (container facts, then the entity). */
export function ancestors(graph: Graph, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const e of graph.outgoing(current, "partOf")) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        out.push(e.to);
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return out;
}

export const isLeafFact = (graph: Graph, node: GraphNode): boolean => node.kind === "fact" && childFacts(graph, node.id).length === 0;

const hasDependents = (graph: Graph, id: string): boolean => graph.incoming(id).some((e) => e.type !== "partOf");

/**
 * Whether anything depends on a fact: an edge into the fact itself, or into one of its
 * containers or its entity (which the fact propagates to through `partOf`).
 */
export function isFactUsed(graph: Graph, id: string): boolean {
  if (hasDependents(graph, id)) return true;
  return ancestors(graph, id).some((a) => hasDependents(graph, a));
}

/**
 * Leaf facts nothing depends on. The compiler-generated `status` fact is excluded: entities
 * carry status for propagation, and nobody is expected to bind to it.
 */
export function unusedLeafFacts(graph: Graph): GraphNode[] {
  return graph
    .nodes({ kind: "fact" })
    .filter((n) => isLeafFact(graph, n) && !n.id.endsWith(".status") && !isFactUsed(graph, n.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** `file:line` for a node, falling back to meta.path / meta.file. */
export function locationOf(node: GraphNode): string | undefined {
  if (node.location?.file) return node.location.line ? `${node.location.file}:${node.location.line}` : node.location.file;
  const path = node.meta?.path ?? node.meta?.file;
  return typeof path === "string" ? path : undefined;
}

/** The file a violation about `node` should point at (YAML definition or source location). */
export function fileOf(node: GraphNode | undefined): string | undefined {
  if (!node) return undefined;
  if (typeof node.meta?.file === "string") return node.meta.file;
  if (node.location?.file) return node.location.file;
  return typeof node.meta?.path === "string" ? node.meta.path : undefined;
}

export const hasType = (node: GraphNode, types: readonly string[]): boolean => node.types?.some((t) => types.includes(t)) ?? false;

export const plural = (n: number, word: string, pluralWord = `${word}s`): string => `${n} ${n === 1 ? word : pluralWord}`;
