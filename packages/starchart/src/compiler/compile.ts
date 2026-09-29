import { Graph } from "../core/graph.js";
import { isEdgeType, type EdgeType } from "../core/model.js";
import { ConfigError, type LoadedProject } from "../config/load.js";

const FACT_SPEC_KEYS = new Set(["value", "authority", "source", "description"]);

/** A fact whose value lives in code; resolved once the code layer is ingested. */
export interface PendingCodeFact {
  factId: string;
  symbol: string;
}

export interface CompileResult {
  graph: Graph;
  pendingCodeFacts: PendingCodeFact[];
  /** Declared edge targets that do not exist yet; code targets may be satisfied later by ingest. */
  danglingTargets: { from: string; to: string; type: EdgeType; file: string }[];
}

/** Turns loaded YAML documents into the fact and world layers plus declared edges. */
export function compileProject(project: LoadedProject): CompileResult {
  const graph = new Graph();
  const pendingCodeFacts: PendingCodeFact[] = [];
  const declared: { from: string; to: string; type: EdgeType; file: string; meta?: Record<string, unknown> }[] = [];

  for (const e of project.entities) {
    graph.addNode({
      id: e.id,
      kind: "entity",
      label: e.label,
      types: e.type,
      status: e.status,
      owners: e.owners,
      validThrough: e.validThrough,
      tags: e.tags,
      meta: { ...e.meta, file: e.file },
    });
    if (e.of) declared.push({ from: e.id, to: e.of, type: "partOf", file: e.file });
    // status is tracked as a fact so retiring an entity propagates like any other change
    const facts = e.status !== undefined && !("status" in e.facts) ? { ...e.facts, status: e.status } : e.facts;
    flattenFacts(graph, e.id, e.id, facts, pendingCodeFacts, e.file, e.owners);
  }

  for (const a of project.artifacts) {
    graph.addNode({
      id: a.id,
      kind: "artifact",
      label: a.label,
      types: a.type,
      binding: a.binding as { adapter: string } | undefined,
      owners: a.owners,
      status: a.status,
      validThrough: a.validThrough,
      tags: a.tags,
      meta: { ...a.meta, file: a.file },
    });
    const simple = ["embeds", "describes", "promotes", "mirrors", "derivedFrom", "captures", "after", "blocks"] as const;
    for (const type of simple) for (const to of a[type] ?? []) declared.push({ from: a.id, to, type, file: a.file });
    if (a.renders) {
      if (typeof a.renders === "string" || Array.isArray(a.renders)) {
        for (const to of [a.renders].flat()) declared.push({ from: a.id, to, type: "renders", file: a.file });
      } else {
        const node = graph.node(a.id)!;
        graph.addNode({ ...node, meta: { ...node.meta, template: a.renders.template, templateOut: a.renders.out } });
        for (const to of a.renders.with) declared.push({ from: a.id, to, type: "renders", file: a.file });
      }
    }
    for (const route of a.publishedBy ?? []) declared.push({ from: route, to: a.id, type: "publishes", file: a.file });
  }

  for (const e of project.edges) {
    if (!isEdgeType(e.type)) throw new ConfigError(`unknown edge type "${e.type}"`, e.file);
    declared.push({ from: e.from, to: e.to, type: e.type, file: e.file, meta: e.confidence ? { confidence: e.confidence } : undefined });
  }

  const danglingTargets: CompileResult["danglingTargets"] = [];
  for (const d of declared) {
    const confidence = typeof d.meta?.confidence === "number" ? d.meta.confidence : undefined;
    graph.addEdge({ from: d.from, to: d.to, type: d.type, origin: "declared", confidence });
    for (const end of [d.from, d.to]) {
      if (!graph.hasNode(end)) danglingTargets.push({ from: d.from, to: end, type: d.type, file: d.file });
    }
  }
  return { graph, pendingCodeFacts, danglingTargets };
}

function isFactSpec(value: unknown): value is { value?: unknown; authority?: string; source?: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => FACT_SPEC_KEYS.has(k)) && ("value" in value || "authority" in value || "source" in value);
}

/**
 * Flattens nested fact objects into leaf and container fact nodes, linked with `partOf`
 * up to the entity: `addon:pro.price.usd --partOf--> addon:pro.price --partOf--> addon:pro`.
 */
function flattenFacts(
  graph: Graph,
  entityId: string,
  parentId: string,
  facts: Record<string, unknown>,
  pending: PendingCodeFact[],
  file: string,
  owners?: string[],
): unknown {
  const assembled: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(facts)) {
    const id = `${parentId}.${key}`;
    if (isFactSpec(raw)) {
      const authority = raw.authority ?? "graph";
      const symbol = typeof raw.source?.symbol === "string" ? raw.source.symbol : undefined;
      graph.addNode({ id, kind: "fact", value: raw.value, authority, source: raw.source, owners, meta: { file, entity: entityId } });
      if (authority === "code") {
        if (!symbol) throw new ConfigError(`fact ${id} has authority "code" but no source.symbol`, file);
        pending.push({ factId: id, symbol: normalizeSymbol(symbol) });
      }
      assembled[key] = raw.value;
    } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      graph.addNode({ id, kind: "fact", owners, meta: { file, entity: entityId } });
      const value = flattenFacts(graph, entityId, id, raw as Record<string, unknown>, pending, file, owners);
      graph.addNode({ id, kind: "fact", value });
      assembled[key] = value;
    } else {
      graph.addNode({ id, kind: "fact", value: raw, authority: "graph", owners, meta: { file, entity: entityId } });
      assembled[key] = raw;
    }
    graph.addEdge({ from: id, to: parentId, type: "partOf", origin: "declared" });
  }
  return assembled;
}

/** "ios/Entitlements.proFeatures" -> "symbol:ios/Entitlements.proFeatures". */
export function normalizeSymbol(ref: string): string {
  return ref.startsWith("symbol:") ? ref : `symbol:${ref}`;
}

/**
 * Pulls code-authority fact values from the ingested code layer and adds the
 * `symbol --anchors--> fact` bridge. Container facts are recomputed afterwards.
 */
export function resolveCodeFacts(graph: Graph, pending: PendingCodeFact[]): { unresolved: PendingCodeFact[] } {
  const unresolved: PendingCodeFact[] = [];
  for (const p of pending) {
    const symbol = graph.node(p.symbol);
    if (!symbol) {
      unresolved.push(p);
      continue;
    }
    const fact = graph.node(p.factId)!;
    graph.addNode({ ...fact, value: symbol.value });
    graph.addEdge({ from: p.symbol, to: p.factId, type: "anchors", origin: "declared" });
  }
  recomputeContainers(graph);
  return { unresolved };
}

/** Rebuilds container fact values from their leaves (after code facts resolve). */
export function recomputeContainers(graph: Graph): void {
  const compute = (id: string): unknown => {
    const children = graph.incoming(id, "partOf").filter((e) => graph.node(e.from)?.kind === "fact");
    const node = graph.node(id)!;
    if (children.length === 0) return node.value;
    const value: Record<string, unknown> = {};
    for (const c of children) value[c.from.slice(id.length + 1)] = compute(c.from);
    if (node.kind === "fact") graph.addNode({ ...node, value });
    return value;
  };
  for (const entity of graph.nodes({ kind: "entity" })) compute(entity.id);
}
