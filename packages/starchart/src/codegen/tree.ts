import type { Graph } from "../core/graph.js";

/** A fact subtree under an entity, in deterministic (key-sorted) order. */
export type FactTree = FactLeaf | FactGroup;

export interface FactLeaf {
  kind: "leaf";
  /** Fact id, e.g. "addon:pro.price.usd". */
  id: string;
  key: string;
  value: unknown;
}

export interface FactGroup {
  kind: "group";
  id: string;
  key: string;
  children: FactTree[];
}

export interface EntityFacts {
  id: string;
  children: FactTree[];
}

/** Marker every generated file carries within its first lines; the code ingestor keys off it. */
export const GENERATED_MARKER = "@starchart generated — do not edit";

/**
 * Collects entities (optionally filtered) with their fact trees, reading the `partOf`
 * hierarchy the compiler builds. Facts without a value (unresolved code facts) are skipped.
 */
export function collectEntities(graph: Graph, only?: readonly string[]): EntityFacts[] {
  const filter = only && only.length ? new Set(only) : undefined;
  return graph
    .nodes({ kind: "entity" })
    .filter((e) => !filter || filter.has(e.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({ id: e.id, children: childrenOf(graph, e.id) }))
    .filter((e) => e.children.length > 0);
}

function childrenOf(graph: Graph, parentId: string): FactTree[] {
  const out: FactTree[] = [];
  const children = graph
    .incoming(parentId, "partOf")
    .map((e) => graph.node(e.from))
    .filter((n) => n?.kind === "fact" && n.id.startsWith(`${parentId}.`))
    .sort((a, b) => a!.id.localeCompare(b!.id));
  for (const node of children) {
    if (!node) continue;
    const key = node.id.slice(parentId.length + 1);
    const grandChildren = childrenOf(graph, node.id);
    if (grandChildren.length > 0) out.push({ kind: "group", id: node.id, key, children: grandChildren });
    else if (node.value !== undefined && !isEmptyContainer(graph, node.id)) {
      out.push({ kind: "leaf", id: node.id, key, value: node.value });
    }
  }
  return out;
}

/** A container fact whose children were all skipped (e.g. unresolved) has nothing to emit. */
function isEmptyContainer(graph: Graph, id: string): boolean {
  return graph.incoming(id, "partOf").some((e) => graph.node(e.from)?.kind === "fact");
}

/** Every leaf, depth first, in emission order. */
export function leaves(trees: readonly FactTree[]): FactLeaf[] {
  const out: FactLeaf[] = [];
  const walk = (t: FactTree) => {
    if (t.kind === "leaf") out.push(t);
    else t.children.forEach(walk);
  };
  trees.forEach(walk);
  return out;
}

/** Splits an arbitrary key or id into identifier words: "addon:pro" → ["addon", "pro"], "productId" → ["product", "id"]. */
export function words(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const leadingDigit = (s: string) => (/^[0-9]/.test(s) ? `_${s}` : s);

export function camelCase(raw: string): string {
  const w = words(raw);
  if (w.length === 0) return "value";
  return leadingDigit(w.map((x, i) => (i === 0 ? x : x.charAt(0).toUpperCase() + x.slice(1))).join(""));
}

export function pascalCase(raw: string): string {
  const w = words(raw);
  if (w.length === 0) return "Value";
  return leadingDigit(w.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(""));
}

export function upperSnake(raw: string): string {
  const w = words(raw);
  if (w.length === 0) return "VALUE";
  return leadingDigit(w.map((x) => x.toUpperCase()).join("_"));
}

/** Returns a function that de-duplicates names within one scope by suffixing _2, _3, ... */
export function uniqueNamer(): (name: string) => string {
  const used = new Map<string, number>();
  return (name) => {
    const count = used.get(name) ?? 0;
    used.set(name, count + 1);
    if (count === 0) return name;
    let candidate = `${name}_${count + 1}`;
    while (used.has(candidate)) candidate = `${candidate}_`;
    used.set(candidate, 1);
    return candidate;
  };
}

export type Scalar = string | number | boolean | null;

export function isScalar(v: unknown): v is Scalar {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Element type of a homogeneous scalar array, or undefined when mixed / non-scalar. */
export function arrayElementType(values: readonly unknown[]): "string" | "int" | "double" | "bool" | undefined {
  if (values.length === 0) return "string";
  if (values.every((v) => typeof v === "string")) return "string";
  if (values.every((v) => typeof v === "boolean")) return "bool";
  if (values.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return values.every((v) => Number.isInteger(v)) ? "int" : "double";
  }
  return undefined;
}

export function sortedEntries(obj: Record<string, unknown>): [string, unknown][] {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
}

/** Comment-safe text: no line breaks or comment terminators. */
export function commentSafe(text: string): string {
  return text.replace(/\*\//g, "* /").replace(/[\r\n\u2028\u2029]+/g, " ");
}
