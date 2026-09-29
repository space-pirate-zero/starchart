import { LAYER_OF, type EdgeType, type GraphEdge, type GraphNode, type Layer, type NodeKind } from "./model.js";

export interface SerializedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const edgeKey = (e: Pick<GraphEdge, "from" | "to" | "type">) => `${e.from}\u0000${e.type}\u0000${e.to}`;

/** In-memory multi-layer graph with indexed incoming/outgoing edges. */
export class Graph {
  private readonly nodeMap = new Map<string, GraphNode>();
  private readonly edgeMap = new Map<string, GraphEdge>();
  private readonly outIndex = new Map<string, Set<string>>();
  private readonly inIndex = new Map<string, Set<string>>();

  static from(data: SerializedGraph): Graph {
    const g = new Graph();
    for (const n of data.nodes) g.addNode(n);
    for (const e of data.edges) g.addEdge(e);
    return g;
  }

  /** Adds a node, merging fields into an existing node with the same id. */
  addNode(node: Omit<GraphNode, "layer"> & { layer?: Layer }): GraphNode {
    const existing = this.nodeMap.get(node.id);
    const layer = node.layer ?? LAYER_OF[node.kind];
    if (existing) {
      const merged: GraphNode = { ...existing, ...stripUndefined(node), layer: existing.layer };
      if (existing.meta || node.meta) merged.meta = { ...existing.meta, ...node.meta };
      if (existing.tags || node.tags) merged.tags = [...new Set([...(existing.tags ?? []), ...(node.tags ?? [])])];
      this.nodeMap.set(node.id, merged);
      return merged;
    }
    const created: GraphNode = { ...stripUndefined(node), layer } as GraphNode;
    this.nodeMap.set(node.id, created);
    return created;
  }

  /** Adds an edge. A duplicate (same from/type/to) keeps the higher confidence and the stronger origin. */
  addEdge(edge: GraphEdge): GraphEdge {
    const key = edgeKey(edge);
    const existing = this.edgeMap.get(key);
    if (existing) {
      const confidence = Math.max(existing.confidence ?? 1, edge.confidence ?? 1);
      const origin = strongerOrigin(existing.origin, edge.origin);
      const merged = { ...existing, ...edge, confidence, origin };
      this.edgeMap.set(key, merged);
      return merged;
    }
    this.edgeMap.set(key, edge);
    getOrCreate(this.outIndex, edge.from).add(key);
    getOrCreate(this.inIndex, edge.to).add(key);
    return edge;
  }

  removeEdge(edge: Pick<GraphEdge, "from" | "to" | "type">): void {
    const key = edgeKey(edge);
    if (!this.edgeMap.delete(key)) return;
    this.outIndex.get(edge.from)?.delete(key);
    this.inIndex.get(edge.to)?.delete(key);
  }

  hasNode(id: string): boolean {
    return this.nodeMap.has(id);
  }

  node(id: string): GraphNode | undefined {
    return this.nodeMap.get(id);
  }

  nodes(filter?: { kind?: NodeKind | NodeKind[]; layer?: Layer; prefix?: string }): GraphNode[] {
    const kinds = filter?.kind ? new Set(Array.isArray(filter.kind) ? filter.kind : [filter.kind]) : undefined;
    const out: GraphNode[] = [];
    for (const n of this.nodeMap.values()) {
      if (kinds && !kinds.has(n.kind)) continue;
      if (filter?.layer && n.layer !== filter.layer) continue;
      if (filter?.prefix && !n.id.startsWith(filter.prefix)) continue;
      out.push(n);
    }
    return out;
  }

  edges(filter?: { type?: EdgeType | EdgeType[] }): GraphEdge[] {
    const all = [...this.edgeMap.values()];
    if (!filter?.type) return all;
    const types = new Set(Array.isArray(filter.type) ? filter.type : [filter.type]);
    return all.filter((e) => types.has(e.type));
  }

  outgoing(id: string, type?: EdgeType): GraphEdge[] {
    return this.collect(this.outIndex.get(id), type);
  }

  incoming(id: string, type?: EdgeType): GraphEdge[] {
    return this.collect(this.inIndex.get(id), type);
  }

  get size(): { nodes: number; edges: number } {
    return { nodes: this.nodeMap.size, edges: this.edgeMap.size };
  }

  /** Merges another graph into this one (used to combine code, fact and world layers). */
  merge(other: Graph | SerializedGraph): this {
    const data = other instanceof Graph ? other.toJSON() : other;
    for (const n of data.nodes) this.addNode(n);
    for (const e of data.edges) this.addEdge(e);
    return this;
  }

  toJSON(): SerializedGraph {
    const nodes = [...this.nodeMap.values()].sort((a, b) => a.id.localeCompare(b.id));
    const edges = [...this.edgeMap.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
    return { nodes, edges };
  }

  private collect(keys: Set<string> | undefined, type?: EdgeType): GraphEdge[] {
    if (!keys) return [];
    const out: GraphEdge[] = [];
    for (const k of keys) {
      const e = this.edgeMap.get(k);
      if (e && (!type || e.type === type)) out.push(e);
    }
    return out;
  }
}

const ORIGIN_RANK = { declared: 3, annotation: 2, extracted: 1, discovered: 0 } as const;

function strongerOrigin(a: GraphEdge["origin"], b: GraphEdge["origin"]): GraphEdge["origin"] {
  if (!a) return b;
  if (!b) return a;
  return ORIGIN_RANK[a] >= ORIGIN_RANK[b] ? a : b;
}

function getOrCreate<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

function stripUndefined<T extends object>(obj: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
