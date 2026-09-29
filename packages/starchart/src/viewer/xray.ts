import type { Graph } from "../core/graph.js";
import { hashValue, staleArtifacts } from "../core/lock.js";
import type { EdgeType, GraphNode } from "../core/model.js";
import type { Project } from "../project.js";

/** Edges through which an artifact literally shows a fact value on a page. */
const VALUE_EDGES: ReadonlySet<EdgeType> = new Set<EdgeType>(["embeds", "mirrors", "renders"]);

export const APP_STORE_URL_PATTERN = "https://apps.apple.com/*";

export interface XrayFact {
  id: string;
  /** Current value, stringified as a page would display it. */
  value: string;
  /** The locked value when it differs from the current one: what stale pages still show. */
  previous?: string;
  /** Artifacts that embed, mirror or render this fact (or one of its ancestors). */
  artifacts: string[];
}

export interface XrayArtifact {
  id: string;
  label?: string;
  /** URL patterns where this artifact is visible; "*" is a wildcard. */
  urls: string[];
  stale: boolean;
  adapter?: string;
  /** How the artifact depends on facts (embeds / mirrors / renders), a hint for auto-fixability. */
  edges: EdgeType[];
}

export interface XrayPayload {
  name: string;
  generatedAt: string;
  facts: XrayFact[];
  artifacts: XrayArtifact[];
  /** Every previous (stale) value, for quick "does this page show an old value" checks. */
  staleValues: string[];
}

function displayable(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return undefined;
}

function isLeafFact(graph: Graph, node: GraphNode): boolean {
  if (node.kind !== "fact") return false;
  return !graph.incoming(node.id, "partOf").some((e) => graph.node(e.from)?.kind === "fact");
}

/** The fact itself plus every ancestor it is partOf (container facts and the entity). */
function lineage(graph: Graph, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    for (const e of graph.outgoing(current, "partOf")) queue.push(e.to);
  }
  return out;
}

function artifactUrls(node: GraphNode, site: string | undefined): string[] {
  const urls = new Set<string>();
  const binding = node.binding;
  if (binding) {
    const raw = binding.url;
    if (binding.adapter === "url" && typeof raw === "string") {
      const resolved = resolveUrl(raw, site);
      if (resolved) urls.add(resolved);
    }
    if (binding.adapter === "appstore") urls.add(APP_STORE_URL_PATTERN);
  }
  const metaUrls = node.meta?.urls;
  if (Array.isArray(metaUrls)) {
    for (const u of metaUrls) {
      if (typeof u !== "string") continue;
      const resolved = resolveUrl(u, site);
      if (resolved) urls.add(resolved);
    }
  }
  return [...urls].sort();
}

function resolveUrl(raw: string, site: string | undefined): string | undefined {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!site) return undefined;
  try {
    // same rule as the url adapter: relative bindings keep the site's base path
    return new URL(raw.replace(/^\/+/, ""), site.endsWith("/") ? site : `${site}/`).toString();
  } catch {
    return undefined;
  }
}

/** The Reality X-Ray payload: displayed fact values, their stale predecessors, and where they live. */
export function xrayPayload(project: Project): XrayPayload {
  const graph = project.graph;
  const lock = project.lock;
  const stale = new Set(staleArtifacts(graph, lock).filter((s) => !s.unlocked).map((s) => s.id));

  // artifact -> edge types, and target -> artifacts, for value-carrying edges only
  const byTarget = new Map<string, Set<string>>();
  const artifactEdges = new Map<string, Set<EdgeType>>();
  for (const e of graph.edges({ type: [...VALUE_EDGES] })) {
    if (graph.node(e.from)?.kind !== "artifact") continue;
    let set = byTarget.get(e.to);
    if (!set) byTarget.set(e.to, (set = new Set()));
    set.add(e.from);
    let types = artifactEdges.get(e.from);
    if (!types) artifactEdges.set(e.from, (types = new Set()));
    types.add(e.type);
  }

  const facts: XrayFact[] = [];
  const staleValues = new Set<string>();
  for (const node of graph.nodes({ kind: "fact" })) {
    if (!isLeafFact(graph, node)) continue;
    const value = displayable(node.value);
    if (value === undefined) continue;
    const fact: XrayFact = { id: node.id, value, artifacts: [] };
    const pinned = lock.facts[node.id];
    if (pinned && pinned.hash !== hashValue(node.value)) {
      const previous = displayable(pinned.value);
      if (previous !== undefined && previous !== value) {
        fact.previous = previous;
        staleValues.add(previous);
      }
    }
    const artifacts = new Set<string>();
    for (const id of lineage(graph, node.id)) for (const a of byTarget.get(id) ?? []) artifacts.add(a);
    fact.artifacts = [...artifacts].sort();
    facts.push(fact);
  }
  facts.sort((a, b) => a.id.localeCompare(b.id));

  const site = project.loaded.config.site;
  const artifacts: XrayArtifact[] = graph
    .nodes({ kind: "artifact" })
    .map((node) => {
      const artifact: XrayArtifact = {
        id: node.id,
        urls: artifactUrls(node, site),
        stale: stale.has(node.id),
        edges: [...(artifactEdges.get(node.id) ?? [])].sort(),
      };
      if (node.label !== undefined) artifact.label = node.label;
      if (node.binding?.adapter) artifact.adapter = node.binding.adapter;
      return artifact;
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    name: project.loaded.config.name,
    generatedAt: new Date().toISOString(),
    facts,
    artifacts,
    staleValues: [...staleValues].sort(),
  };
}
