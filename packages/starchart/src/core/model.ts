/**
 * The STARCHART graph model: three layers (code, fact, world) joined by typed edges.
 *
 * Edge direction convention: `from` DEPENDS ON `to`, except for the few edge types whose
 * propagation is declared "forward" in {@link PROPAGATION}. Impact always flows from a
 * changed node to the nodes that depend on it.
 */

export type Layer = "code" | "fact" | "world";

export type NodeKind =
  // fact layer
  | "entity"
  | "fact"
  // world layer
  | "artifact"
  // code layer
  | "file"
  | "symbol"
  | "package"
  | "route"
  | "screen"
  | "flag"
  | "env"
  | "event"
  | "i18n"
  | "test";

export const LAYER_OF: Record<NodeKind, Layer> = {
  entity: "fact",
  fact: "fact",
  artifact: "world",
  file: "code",
  symbol: "code",
  package: "code",
  route: "code",
  screen: "code",
  flag: "code",
  env: "code",
  event: "code",
  i18n: "code",
  test: "code",
};

export interface Binding {
  adapter: string;
  [key: string]: unknown;
}

export interface SourceRef {
  /** Code symbol id (e.g. "symbol:ios/Entitlements.proFeatures") or a short form resolved by the compiler. */
  symbol?: string;
  file?: string;
  adapter?: string;
  [key: string]: unknown;
}

export interface Location {
  file: string;
  line?: number;
  endLine?: number;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  layer: Layer;
  label?: string;
  /** JSON-LD types, e.g. ["schema:Offer", "sc:AddOn"]. */
  types?: string[];
  /** Fact value (leaf facts) or literal value (code constants). */
  value?: unknown;
  /** Where truth lives for a fact: "graph" (default), "code", "stripe", "appstore", ... */
  authority?: string;
  source?: SourceRef;
  binding?: Binding;
  location?: Location;
  /** Content hash for code nodes; used by the lockfile to detect code drift. */
  hash?: string;
  owners?: string[];
  status?: string;
  validThrough?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
}

export const EDGE_TYPES = [
  // code layer
  "imports",
  "references",
  "dependsOn",
  "tests",
  "serves",
  "readsEnv",
  "readsFlag",
  "contains",
  // bridge layer
  "anchors",
  "displays",
  "captures",
  "publishes",
  "emits",
  // world layer
  "embeds",
  "renders",
  "describes",
  "promotes",
  "mirrors",
  "derivedFrom",
  "after",
  "blocks",
  // fact layer
  "partOf",
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

export type EdgeOrigin = "declared" | "extracted" | "annotation" | "discovered";

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  /** 0..1. Declared and extracted edges default to 1. */
  confidence?: number;
  origin?: EdgeOrigin;
  meta?: Record<string, unknown>;
}

/**
 * How a change propagates across an edge.
 * - "reverse": a change to `to` impacts `from` (from depends on to). The default.
 * - "forward": a change to `from` impacts `to`.
 * - "both":    either end changing impacts the other (anchors: code literal <-> fact value).
 * - "none":    structural or ordering only; never propagates.
 */
export const PROPAGATION: Record<EdgeType, "reverse" | "forward" | "both" | "none"> = {
  imports: "reverse",
  references: "reverse",
  dependsOn: "reverse",
  tests: "reverse",
  serves: "reverse",
  readsEnv: "reverse",
  readsFlag: "reverse",
  contains: "none",
  anchors: "both",
  displays: "reverse",
  captures: "reverse",
  publishes: "forward",
  emits: "forward",
  embeds: "reverse",
  renders: "reverse",
  describes: "reverse",
  promotes: "reverse",
  mirrors: "reverse",
  derivedFrom: "reverse",
  after: "none",
  blocks: "none",
  partOf: "forward",
};

export const BRIDGE_EDGES: ReadonlySet<EdgeType> = new Set(["anchors", "displays", "captures", "publishes", "emits"]);

export function isEdgeType(value: string): value is EdgeType {
  return (EDGE_TYPES as readonly string[]).includes(value);
}
