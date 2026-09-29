import type { Graph } from "./graph.js";
import { PROPAGATION, type EdgeType, type GraphEdge, type GraphNode } from "./model.js";

export type ImpactClass = "auto" | "review" | "manual" | "retire" | "break" | "code" | "test" | "info";

/** One hop along an impact path: `from` changed, so `to` is impacted, across an edge of `type`. */
export interface ImpactHop {
  from: string;
  to: string;
  type: EdgeType;
}

export interface ImpactItem {
  id: string;
  node: GraphNode;
  depth: number;
  confidence: number;
  /** Edge type of the final hop — decides the class. */
  via: EdgeType;
  path: ImpactHop[];
  class: ImpactClass;
  reason: string;
}

export interface ImpactOptions {
  maxDepth?: number;
  /** Maximum consecutive hops inside the code layer. Keeps "everything imports everything" in check. */
  maxCodeDepth?: number;
  minConfidence?: number;
  /** Only traverse these edge types. */
  edgeTypes?: EdgeType[];
  /**
   * Which code nodes to report (all are traversed):
   * "surface" = screens, routes, tests and anchored symbols; "all"; "none".
   */
  includeCode?: "surface" | "all" | "none";
  /** Whether an adapter can write this artifact. Decides auto vs manual. */
  canWrite?: (adapter: string, node?: GraphNode) => boolean;
  now?: Date;
}

export interface ImpactResult {
  seeds: string[];
  items: ImpactItem[];
}

/** Confidence decay per hop for coarse-grained code edges. */
const DECAY: Partial<Record<EdgeType, number>> = {
  imports: 0.85,
  dependsOn: 0.7,
  references: 0.95,
  readsEnv: 0.9,
  readsFlag: 0.9,
};

const MEDIA_TYPES = new Set(["schema:ImageObject", "schema:VideoObject", "schema:MediaObject", "sc:Print"]);

const defaultCanWrite = (adapter: string) => adapter === "fs";

/**
 * Walks every layer from the changed seeds and returns the classified impact set.
 * Breadth-first, so each item carries its shortest explanation path.
 */
export function computeImpact(graph: Graph, seeds: string[], options: ImpactOptions = {}): ImpactResult {
  const maxDepth = options.maxDepth ?? 12;
  const maxCodeDepth = options.maxCodeDepth ?? 4;
  const minConfidence = options.minConfidence ?? 0.3;
  const allowed = options.edgeTypes ? new Set(options.edgeTypes) : undefined;
  const includeCode = options.includeCode ?? "surface";
  const canWrite = options.canWrite ?? defaultCanWrite;
  const now = options.now ?? new Date();

  const seedSet = new Set(seeds.filter((s) => graph.hasNode(s)));
  interface QueueEntry {
    id: string;
    depth: number;
    codeDepth: number;
    confidence: number;
    path: ImpactHop[];
  }
  const visited = new Map<string, QueueEntry>();
  const queue: QueueEntry[] = [];
  for (const id of seedSet) {
    const entry = { id, depth: 0, codeDepth: 0, confidence: 1, path: [] };
    visited.set(id, entry);
    queue.push(entry);
  }

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    if (current.depth >= maxDepth) continue;
    const currentNode = graph.node(current.id);
    for (const { edge, target } of neighbors(graph, current.id)) {
      if (allowed && !allowed.has(edge.type)) continue;
      if (visited.has(target)) continue;
      const targetNode = graph.node(target);
      if (!targetNode) continue;
      const codeHop = currentNode?.layer === "code" && targetNode.layer === "code";
      const codeDepth = codeHop ? current.codeDepth + 1 : 0;
      if (codeDepth > maxCodeDepth) continue;
      const confidence = current.confidence * (edge.confidence ?? 1) * (DECAY[edge.type] ?? 1);
      if (confidence < minConfidence) continue;
      const entry: QueueEntry = {
        id: target,
        depth: current.depth + 1,
        codeDepth,
        confidence,
        path: [...current.path, { from: current.id, to: target, type: edge.type }],
      };
      visited.set(target, entry);
      queue.push(entry);
    }
  }

  const items: ImpactItem[] = [];
  for (const entry of visited.values()) {
    if (seedSet.has(entry.id)) continue;
    const node = graph.node(entry.id)!;
    const via = entry.path[entry.path.length - 1]!.type;
    if (node.layer === "code" && !reportCode(node, via, includeCode)) continue;
    const { cls, reason } = classify(graph, node, via, entry.path, canWrite, now);
    items.push({
      id: entry.id,
      node,
      depth: entry.depth,
      confidence: round(entry.confidence),
      via,
      path: entry.path,
      class: cls,
      reason,
    });
  }
  items.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  return { seeds: [...seedSet], items };
}

/** Nodes impacted when `id` changes, honouring each edge type's propagation direction. */
export function neighbors(graph: Graph, id: string): { edge: GraphEdge; target: string }[] {
  const out: { edge: GraphEdge; target: string }[] = [];
  for (const edge of graph.incoming(id)) {
    const p = PROPAGATION[edge.type];
    if (p === "reverse" || p === "both") out.push({ edge, target: edge.from });
  }
  for (const edge of graph.outgoing(id)) {
    const p = PROPAGATION[edge.type];
    if (p === "forward" || p === "both") out.push({ edge, target: edge.to });
  }
  // A changed symbol means its file changed, for the coarse file-level `imports` graph.
  for (const edge of graph.incoming(id, "contains")) out.push({ edge: { ...edge, confidence: 0.8 }, target: edge.from });
  return out;
}

function reportCode(node: GraphNode, via: EdgeType, mode: ImpactOptions["includeCode"]): boolean {
  if (mode === "all") return true;
  if (mode === "none") return false;
  return node.kind === "screen" || node.kind === "route" || node.kind === "test" || via === "anchors";
}

export function classify(
  graph: Graph,
  node: GraphNode,
  via: EdgeType,
  path: ImpactHop[],
  canWrite: (adapter: string, node?: GraphNode) => boolean,
  now: Date,
): { cls: ImpactClass; reason: string } {
  if (node.layer === "code") {
    if (node.kind === "test") return { cls: "test", reason: "run these tests" };
    if (via === "anchors") {
      if (node.meta?.generated) return { cls: "auto", reason: "regenerate fact constants (codegen)" };
      const from = graph.node(path[path.length - 1]!.from);
      if (from?.kind === "artifact") return { cls: "code", reason: "holds this artifact's external id; update it if the id changes" };
      return { cls: "code", reason: "hardcoded value anchors this fact; update or switch to codegen" };
    }
    return { cls: "info", reason: `${node.kind} affected` };
  }
  if (node.layer === "fact") return { cls: "info", reason: "derived fact changes" };

  // world artifacts
  if (node.validThrough && Date.parse(node.validThrough) < now.getTime()) {
    return { cls: "retire", reason: `expired ${node.validThrough}` };
  }
  const retiredOnPath = path.some((hop) => graph.node(hop.from)?.status === "retired");
  if (retiredOnPath && (via === "promotes" || via === "embeds" || via === "describes")) {
    return { cls: "retire", reason: "depends on a retired entity" };
  }
  const adapter = node.binding?.adapter;
  const writable = adapter ? canWrite(adapter, node) : false;
  const isMedia = node.types?.some((t) => MEDIA_TYPES.has(t)) ?? false;
  switch (via) {
    case "renders":
      return { cls: "auto", reason: "regenerate from template" };
    case "embeds":
      if (isMedia) return { cls: "manual", reason: "value is burned into media" };
      return writable
        ? { cls: "auto", reason: "replace embedded value" }
        : { cls: "manual", reason: adapter ? `adapter "${adapter}" cannot write` : "no binding" };
    case "mirrors":
      return writable
        ? { cls: "auto", reason: `sync via ${adapter}` }
        : { cls: "manual", reason: adapter ? `update in ${adapter} (adapter is read-only)` : "no binding" };
    case "captures":
      return { cls: "manual", reason: "screen changed; re-capture" };
    case "describes":
      return { cls: "review", reason: "describes this semantically" };
    case "promotes":
      return { cls: "review", reason: "promotes this; check it still holds" };
    case "derivedFrom":
      return { cls: "review", reason: "derived from a changed artifact" };
    case "publishes":
      return { cls: "review", reason: "published page changed" };
    case "emits":
      return { cls: "review", reason: "emitted event/ID changed" };
    default:
      return { cls: "review", reason: `impacted via ${via}` };
  }
}

/** Human-readable explanation, e.g. `PaywallView.swift -[contains]-> ... -[captures]-> screenshot`. */
export function explainPath(path: ImpactHop[]): string {
  if (path.length === 0) return "";
  const parts = [path[0]!.from];
  for (const hop of path) parts.push(`--${hop.type}--> ${hop.to}`);
  return parts.join(" ");
}

const round = (n: number) => Math.round(n * 100) / 100;
