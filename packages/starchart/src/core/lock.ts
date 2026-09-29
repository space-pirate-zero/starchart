import { createHash } from "node:crypto";
import type { Graph } from "./graph.js";
import { PROPAGATION, type GraphNode } from "./model.js";

/**
 * starchart.lock — pins every artifact to the fact values and code hashes it was last
 * produced against. A dependency whose current hash differs from the pinned one makes
 * the artifact stale.
 */
export interface LockFile {
  version: 1;
  /** Code hops followed when pinning dependencies (config `code.maxCodeDepth`). */
  maxCodeDepth?: number;
  facts: Record<string, { hash: string; value: unknown }>;
  code: Record<string, string>;
  artifacts: Record<string, { deps: Record<string, string> }>;
}

export const emptyLock = (): LockFile => ({ version: 1, facts: {}, code: {}, artifacts: {} });

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export const hashValue = (value: unknown): string =>
  createHash("sha1").update(stableStringify(value)).digest("hex").slice(0, 16);

/** Current hash for a node that participates in drift tracking, or undefined. */
export function currentHash(node: GraphNode): string | undefined {
  if (node.kind === "fact") return hashValue(node.value);
  if (node.layer === "code") return node.hash;
  return undefined;
}

/**
 * Every fact and hashed code node whose change would impact `artifactId`:
 * a reverse walk against each edge's propagation direction.
 */
export function dependencies(graph: Graph, artifactId: string, maxCodeDepth: number = 4): string[] {
  const out = new Set<string>();
  const seen = new Map<string, number>([[artifactId, 0]]);
  const queue: { id: string; codeDepth: number }[] = [{ id: artifactId, codeDepth: 0 }];
  for (let head = 0; head < queue.length; head++) {
    const { id, codeDepth } = queue[head]!;
    const node = graph.node(id);
    const upstream: string[] = [];
    for (const e of graph.outgoing(id)) {
      const p = PROPAGATION[e.type];
      if (p === "reverse" || p === "both") upstream.push(e.to);
    }
    for (const e of graph.incoming(id)) {
      const p = PROPAGATION[e.type];
      if (p === "forward" || p === "both") upstream.push(e.from);
    }
    // a file depends on the symbols it contains
    for (const e of graph.outgoing(id, "contains")) upstream.push(e.to);
    for (const up of upstream) {
      const upNode = graph.node(up);
      if (!upNode) continue;
      const nextCodeDepth = node?.layer === "code" && upNode.layer === "code" ? codeDepth + 1 : 0;
      if (nextCodeDepth > maxCodeDepth) continue;
      const prev = seen.get(up);
      if (prev !== undefined && prev <= nextCodeDepth) continue;
      seen.set(up, nextCodeDepth);
      if (currentHash(upNode) !== undefined) out.add(up);
      queue.push({ id: up, codeDepth: nextCodeDepth });
    }
  }
  return [...out].sort();
}

/**
 * Builds a lock that marks the given artifacts (default: all) as in sync with the current graph.
 * Artifacts not listed keep their previous pins.
 */
export function buildLock(
  graph: Graph,
  previous: LockFile = emptyLock(),
  artifactIds?: string[],
  opts: { maxCodeDepth?: number } = {},
): LockFile {
  const maxCodeDepth = opts.maxCodeDepth ?? previous.maxCodeDepth;
  const lock: LockFile = { version: 1, facts: {}, code: {}, artifacts: { ...previous.artifacts } };
  if (maxCodeDepth !== undefined) lock.maxCodeDepth = maxCodeDepth;
  for (const n of graph.nodes({ kind: "fact" })) lock.facts[n.id] = { hash: hashValue(n.value), value: n.value };
  const trackedCode = new Set<string>();

  const targets = artifactIds ?? graph.nodes({ kind: "artifact" }).map((n) => n.id);
  for (const id of targets) {
    const deps: Record<string, string> = {};
    for (const dep of dependencies(graph, id, maxCodeDepth)) {
      deps[dep] = currentHash(graph.node(dep)!)!;
      if (graph.node(dep)!.layer === "code") trackedCode.add(dep);
    }
    lock.artifacts[id] = { deps };
  }
  // keep the code pins that other (not re-synced) artifacts still reference
  for (const entry of Object.values(lock.artifacts)) for (const dep of Object.keys(entry.deps)) {
    const node = graph.node(dep);
    if (node?.layer === "code") trackedCode.add(dep);
  }
  for (const id of [...trackedCode].sort()) {
    const node = graph.node(id);
    const hash = node && currentHash(node);
    if (hash) lock.code[id] = hash;
  }
  // drop artifacts that no longer exist
  for (const id of Object.keys(lock.artifacts)) if (!graph.hasNode(id)) delete lock.artifacts[id];
  return lock;
}

export interface StaleArtifact {
  id: string;
  changed: string[];
  /** Artifact exists in the graph but was never locked. */
  unlocked: boolean;
}

/** Artifacts whose pinned dependencies no longer match the graph. */
export function staleArtifacts(graph: Graph, lock: LockFile): StaleArtifact[] {
  const stale: StaleArtifact[] = [];
  for (const node of graph.nodes({ kind: "artifact" })) {
    const entry = lock.artifacts[node.id];
    if (!entry) {
      stale.push({ id: node.id, changed: [], unlocked: true });
      continue;
    }
    const changed: string[] = [];
    const current = new Set(dependencies(graph, node.id, lock.maxCodeDepth));
    for (const [dep, hash] of Object.entries(entry.deps)) {
      const depNode = graph.node(dep);
      if (!depNode || currentHash(depNode) !== hash) changed.push(dep);
    }
    for (const dep of current) if (!(dep in entry.deps)) changed.push(dep);
    if (changed.length) stale.push({ id: node.id, changed: [...new Set(changed)].sort(), unlocked: false });
  }
  return stale.sort((a, b) => a.id.localeCompare(b.id));
}

/** Facts and code nodes whose hash differs from the lock: the seeds for a plan. */
export function changedSince(graph: Graph, lock: LockFile): { id: string; before?: unknown; after?: unknown }[] {
  const out: { id: string; before?: unknown; after?: unknown }[] = [];
  for (const n of graph.nodes({ kind: "fact" })) {
    const pinned = lock.facts[n.id];
    if (!pinned) continue; // new facts have no dependents that were synced against them
    if (pinned.hash !== hashValue(n.value)) out.push({ id: n.id, before: pinned.value, after: n.value });
  }
  for (const [id, hash] of Object.entries(lock.code)) {
    const node = graph.node(id);
    if (!node) out.push({ id, before: hash, after: undefined });
    else if (node.hash !== hash) out.push({ id, before: hash, after: node.hash });
  }
  return out;
}

/**
 * Pins `ids` to the current graph like {@link buildLock}, but keeps the previous value of every
 * fact that a still-stale artifact depends on. Those artifacts can then still find the old text to
 * replace, and plans keep listing them until they are synced or acked.
 */
export function relockArtifacts(graph: Graph, previous: LockFile, ids: string[], opts: { maxCodeDepth?: number } = {}): LockFile {
  const next = buildLock(graph, previous, ids, opts);
  for (const stale of staleArtifacts(graph, next)) {
    if (stale.unlocked) continue;
    for (const dep of stale.changed) {
      const pinned = previous.facts[dep];
      if (pinned && graph.node(dep)?.kind === "fact") next.facts[dep] = pinned;
    }
  }
  return next;
}
