import { nameTokens } from "../code/util.js";
import type { Graph } from "../core/graph.js";
import { stableStringify } from "../core/lock.js";
import type { GraphEdge, GraphNode } from "../core/model.js";
import { GENERIC_VALUES, leafFacts, LiteralMatcher, normalizeBindingPath, searchText } from "./literals.js";
import type { LiteralOccurrence } from "./scan.js";

export type DiscoveredEdge = GraphEdge & { reason: string };

const STOP_TOKENS = new Set(["the", "and", "for", "get", "set", "value", "values", "key", "keys", "data", "info", "item", "items", "list", "static", "const", "default"]);

/** A value distinctive enough that equality with a fact is meaningful evidence. */
export function isDistinctiveValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length >= 4 && !GENERIC_VALUES.has(value.trim().toLowerCase());
  if (typeof value === "number") return Number.isFinite(value) && !Number.isInteger(value);
  if (Array.isArray(value)) return value.length >= 2 && value.every((v) => typeof v === "string");
  return false;
}

function meaningfulTokens(name: string): Set<string> {
  return new Set(nameTokens(name).filter((t) => t.length >= 3 && !STOP_TOKENS.has(t)));
}

/** Whether a code symbol's name shares a meaningful word with the fact's key path. */
export function nameResembles(symbol: GraphNode, fact: GraphNode): boolean {
  const symName = typeof symbol.meta?.qname === "string" ? symbol.meta.qname : (symbol.label ?? symbol.id.replace(/^.*[/#]/, ""));
  const factKey = fact.id.includes(":") ? fact.id.slice(fact.id.indexOf(":") + 1) : fact.id;
  const a = meaningfulTokens(symName);
  for (const t of meaningfulTokens(factKey)) if (a.has(t)) return true;
  return false;
}

const display = (v: unknown) => {
  const s = typeof v === "string" ? JSON.stringify(v) : stableStringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/**
 * Proposes bridge edges the chart does not have yet:
 * 1. code symbol whose literal value equals a distinctive leaf fact value -> `anchors`;
 * 2. unbound fact literal inside a file that an fs-bound artifact covers -> artifact `embeds` fact;
 * 3. localization string containing a fact value -> i18n `anchors` fact.
 * Edges already in the graph are skipped.
 */
export function discoverEdges(graph: Graph, occurrences?: LiteralOccurrence[]): DiscoveredEdge[] {
  const out = new Map<string, DiscoveredEdge>();
  const push = (e: DiscoveredEdge) => {
    const key = `${e.from}\u0000${e.type}\u0000${e.to}`;
    if (graph.outgoing(e.from, e.type).some((x) => x.to === e.to)) return;
    const prev = out.get(key);
    if (!prev || (prev.confidence ?? 0) < (e.confidence ?? 0)) out.set(key, e);
  };
  const leaves = leafFacts(graph);

  // 1. symbol literal == fact value
  const byValue = new Map<string, GraphNode[]>();
  for (const f of leaves) {
    if (!isDistinctiveValue(f.value)) continue;
    const key = stableStringify(f.value);
    const list = byValue.get(key);
    if (list) list.push(f);
    else byValue.set(key, [f]);
  }
  if (byValue.size) {
    for (const sym of graph.nodes({ kind: "symbol" })) {
      if (sym.value === undefined) continue;
      const facts = byValue.get(stableStringify(sym.value));
      if (!facts) continue;
      const resembling = facts.filter((f) => nameResembles(sym, f));
      for (const f of facts) {
        const resembles = resembling.includes(f);
        let confidence: number;
        if (facts.length === 1) confidence = resembles ? 0.9 : 0.6;
        else if (resembling.length === 1) confidence = resembles ? 0.9 : 0.4;
        else confidence = resembles ? 0.75 : 0.4;
        push({
          from: sym.id,
          to: f.id,
          type: "anchors",
          confidence,
          origin: "discovered",
          reason: `${sym.label ?? sym.id} = ${display(sym.value)} equals ${f.id}${resembles ? " and the names match" : ""}${facts.length > 1 ? ` (${facts.length} facts share this value)` : ""}`,
        });
      }
    }
  }

  // 2. unbound literals inside files that fs-bound artifacts cover
  if (occurrences?.length) {
    const artifactsByPath = new Map<string, string[]>();
    for (const a of graph.nodes({ kind: "artifact" })) {
      if (a.binding?.adapter !== "fs" || typeof a.binding.path !== "string") continue;
      const p = normalizeBindingPath(a.binding.path);
      const list = artifactsByPath.get(p);
      if (list) list.push(a.id);
      else artifactsByPath.set(p, [a.id]);
    }
    for (const o of occurrences) {
      if (o.bound) continue;
      for (const artifact of artifactsByPath.get(o.file) ?? []) {
        push({
          from: artifact,
          to: o.factId,
          type: "embeds",
          confidence: 0.7,
          origin: "discovered",
          reason: `${display(o.value)} appears unbound at ${o.file}:${o.line}`,
        });
      }
    }
  }

  // 3. localization strings containing fact values
  const needles = new Map<string, string[]>();
  for (const f of leaves) {
    const text = searchText(f);
    if (text === undefined) continue;
    const list = needles.get(text);
    if (list) list.push(f.id);
    else needles.set(text, [f.id]);
  }
  if (needles.size) {
    const matcher = new LiteralMatcher(needles.keys());
    for (const node of graph.nodes({ kind: "i18n" })) {
      if (!node.value || typeof node.value !== "object") continue;
      for (const [locale, str] of Object.entries(node.value as Record<string, unknown>)) {
        if (typeof str !== "string") continue;
        for (const { needle } of matcher.matches(str)) {
          for (const factId of needles.get(needle) ?? []) {
            push({
              from: node.id,
              to: factId,
              type: "anchors",
              confidence: 0.6,
              origin: "discovered",
              reason: `${locale} copy for ${node.label ?? node.id} contains ${display(needle)}`,
            });
          }
        }
      }
    }
  }

  return [...out.values()].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** Adds discovered edges at or above `minConfidence` to the graph; returns the ones added. */
export function applyDiscovered(graph: Graph, edges: DiscoveredEdge[], minConfidence = 0.8): GraphEdge[] {
  const added: GraphEdge[] = [];
  for (const { reason, ...edge } of edges) {
    if ((edge.confidence ?? 1) < minConfidence) continue;
    if (graph.outgoing(edge.from, edge.type).some((x) => x.to === edge.to)) continue;
    const e: GraphEdge = { ...edge, meta: { ...edge.meta, reason } };
    graph.addEdge(e);
    added.push(e);
  }
  return added;
}
