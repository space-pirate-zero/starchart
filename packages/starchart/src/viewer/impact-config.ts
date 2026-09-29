import { Graph, type SerializedGraph } from "../core/graph.js";
import { classify, computeImpact } from "../core/impact.js";
import { BRIDGE_EDGES, EDGE_TYPES, PROPAGATION, type EdgeType } from "../core/model.js";

/**
 * Everything the in-browser impact port (assets/impact-core.js) needs, derived from the
 * core at render time. Propagation comes straight from the model; per-edge confidence
 * decay, the `contains` hop confidence and media types are measured by running the core
 * itself on probe graphs, so the browser can never drift from `computeImpact`.
 */
export interface ImpactConfig {
  propagation: Record<EdgeType, "reverse" | "forward" | "both" | "none">;
  decay: Partial<Record<EdgeType, number>>;
  containsConfidence: number;
  mediaTypes: string[];
  writable: string[];
  /** Artifacts whose adapter writes, but not this binding (adapter canApply veto). */
  unwritable: string[];
  bridgeEdges: EdgeType[];
  maxDepth: number;
  maxCodeDepth: number;
  minConfidence: number;
}

/** Core defaults for computeImpact (see src/core/impact.ts). */
export const DEFAULT_MAX_DEPTH = 12;
export const DEFAULT_MAX_CODE_DEPTH = 4;
export const DEFAULT_MIN_CONFIDENCE = 0.3;

let probedDecay: { decay: Partial<Record<EdgeType, number>>; containsConfidence: number } | undefined;

/** Per-hop confidence multiplier of each propagating edge type, measured through the core. */
export function probeDecay(): { decay: Partial<Record<EdgeType, number>>; containsConfidence: number } {
  if (probedDecay) return probedDecay;
  const decay: Partial<Record<EdgeType, number>> = {};
  for (const type of EDGE_TYPES) {
    const direction = PROPAGATION[type];
    if (direction === "none") continue;
    const g = new Graph();
    g.addNode({ id: "probe:a", kind: "symbol" });
    g.addNode({ id: "probe:b", kind: "symbol" });
    if (direction === "forward") g.addEdge({ from: "probe:a", to: "probe:b", type });
    else g.addEdge({ from: "probe:b", to: "probe:a", type });
    const { items } = computeImpact(g, ["probe:a"], { includeCode: "all", minConfidence: 0, maxCodeDepth: 1 });
    const confidence = items[0]?.confidence ?? 1;
    if (confidence !== 1) decay[type] = confidence;
  }
  const g = new Graph();
  g.addNode({ id: "probe:file", kind: "file" });
  g.addNode({ id: "probe:symbol", kind: "symbol" });
  g.addEdge({ from: "probe:file", to: "probe:symbol", type: "contains" });
  const { items } = computeImpact(g, ["probe:symbol"], { includeCode: "all", minConfidence: 0, maxCodeDepth: 1 });
  probedDecay = { decay, containsConfidence: items[0]?.confidence ?? 1 };
  return probedDecay;
}

/** The subset of JSON-LD types in `graph` that the core treats as burned-in media. */
export function probeMediaTypes(graph: SerializedGraph): string[] {
  const candidates = new Set<string>();
  for (const n of graph.nodes) if (n.layer === "world") for (const t of n.types ?? []) candidates.add(t);
  const probe = new Graph();
  const now = new Date();
  const media: string[] = [];
  for (const type of [...candidates].sort()) {
    const node = probe.addNode({ id: "probe:artifact", kind: "artifact", types: [type], binding: { adapter: "probe" } });
    if (classify(probe, node, "embeds", [], () => true, now).cls === "manual") media.push(type);
  }
  return media;
}

export function impactConfig(
  graph: SerializedGraph,
  options: { writableAdapters?: string[]; unwritableArtifacts?: string[]; maxCodeDepth?: number } = {},
): ImpactConfig {
  const { decay, containsConfidence } = probeDecay();
  return {
    propagation: { ...PROPAGATION },
    decay,
    containsConfidence,
    mediaTypes: probeMediaTypes(graph),
    writable: [...new Set(options.writableAdapters ?? [])].sort(),
    unwritable: [...new Set(options.unwritableArtifacts ?? [])].sort(),
    bridgeEdges: [...BRIDGE_EDGES],
    maxDepth: DEFAULT_MAX_DEPTH,
    maxCodeDepth: options.maxCodeDepth ?? DEFAULT_MAX_CODE_DEPTH,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
  };
}

/** Artifacts bound to a writable adapter that nonetheless cannot write that binding. */
export function unwritableArtifacts(
  graph: SerializedGraph,
  writable: string[],
  canWriteNode: (adapter: string, node: SerializedGraph["nodes"][number]) => boolean,
): string[] {
  const out: string[] = [];
  for (const n of graph.nodes) {
    const adapter = n.binding?.adapter;
    if (n.kind === "artifact" && adapter && writable.includes(adapter) && !canWriteNode(adapter, n)) out.push(n.id);
  }
  return out.sort();
}

/** Distinct adapters bound in `graph` that `canWrite` accepts. */
export function writableAdapters(graph: SerializedGraph, canWrite: (adapter: string) => boolean): string[] {
  const adapters = new Set<string>();
  for (const n of graph.nodes) if (n.binding?.adapter) adapters.add(n.binding.adapter);
  return [...adapters].filter((a) => canWrite(a)).sort();
}
