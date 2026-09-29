import { relative, resolve } from "node:path";
import { canWrite as adapterCanWrite } from "./adapters/registry.js";
import { changedNodesFromDiff } from "./code/index.js";
import type { Graph } from "./core/graph.js";
import { computeImpact, type ImpactItem, type ImpactOptions, type ImpactResult } from "./core/impact.js";
import { changedSince, staleArtifacts, type StaleArtifact } from "./core/lock.js";
import { orderSteps, type OrderedStep } from "./core/order.js";
import type { Project } from "./project.js";

/** High-level operations shared by the CLI, MCP server, hooks and GitHub Action. */

export interface Change {
  id: string;
  before?: unknown;
  after?: unknown;
}

export interface Plan {
  changes: Change[];
  impact: ImpactResult;
  steps: OrderedStep[];
  cycles: string[][];
  summary: Record<ImpactItem["class"], number>;
}

const ACTIONABLE = new Set<ImpactItem["class"]>(["auto", "review", "manual", "retire", "break", "code"]);

export function impactOptions(project: Project, extra: ImpactOptions = {}): ImpactOptions {
  const settings = project.loaded.config.adapters;
  return {
    maxCodeDepth: project.loaded.config.code.maxCodeDepth,
    canWrite: (adapter) => adapterCanWrite(adapter, settings),
    ...extra,
  };
}

export function summarize(items: ImpactItem[]): Plan["summary"] {
  const summary = { auto: 0, review: 0, manual: 0, retire: 0, break: 0, code: 0, test: 0, info: 0 };
  for (const i of items) summary[i.class]++;
  return summary;
}

/** Plans from explicit seeds (changed node ids). */
export function planFromSeeds(project: Project, changes: Change[], extra?: ImpactOptions): Plan {
  const impact = computeImpact(
    project.graph,
    changes.map((c) => c.id),
    impactOptions(project, extra),
  );
  const actionable = impact.items.filter((i) => ACTIONABLE.has(i.class));
  const { steps, cycles } = orderSteps(project.graph, actionable);
  return { changes, impact, steps, cycles, summary: summarize(impact.items) };
}

/** Plans everything that changed since the lock (facts edited in YAML, code hashes moved). */
export function planFromLock(project: Project, extra?: ImpactOptions): Plan {
  return planFromSeeds(project, changedSince(project.graph, project.lock), extra);
}

/** Plans the blast radius of a git diff against `base`. */
export async function planFromDiff(project: Project, base: string, extra?: ImpactOptions): Promise<Plan> {
  const ids = await changedNodesFromDiff(project.root, project.loaded.config.code, project.graph, base);
  const fromLock = changedSince(project.graph, project.lock).filter((c) => project.graph.node(c.id)?.kind === "fact");
  const seen = new Set<string>();
  const changes: Change[] = [];
  for (const c of [...ids.map((id) => ({ id })), ...fromLock]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    changes.push(c);
  }
  return planFromSeeds(project, changes, extra);
}

export function check(project: Project): StaleArtifact[] {
  return staleArtifacts(project.graph, project.lock);
}

/**
 * Resolves a user-supplied reference to node ids. Accepts an exact id, a file path
 * (resolved to the file node and every symbol it contains), or a unique id suffix.
 */
export function resolveRef(project: Project, ref: string, cwd = process.cwd()): string[] {
  const g = project.graph;
  if (g.hasNode(ref)) return [ref];

  const rel = relative(project.root, resolve(cwd, ref)).split("\\").join("/");
  const fileNodes = g.nodes({ kind: ["file", "test"] }).filter((n) => n.location?.file === rel || n.meta?.path === rel);
  if (fileNodes.length) {
    const ids = new Set<string>();
    for (const f of fileNodes) {
      ids.add(f.id);
      for (const e of g.outgoing(f.id, "contains")) ids.add(e.to);
    }
    return [...ids];
  }

  const suffix = g.nodes().filter((n) => n.id.endsWith(ref) || n.id.endsWith(`/${ref}`) || n.label === ref);
  return suffix.length === 1 ? [suffix[0]!.id] : suffix.map((n) => n.id).slice(0, 25);
}

/** Every path explaining why `target` depends on `source` (shortest first). */
export function why(project: Project, source: string, target: string): ImpactItem | undefined {
  const { items } = computeImpact(project.graph, [source], impactOptions(project, { includeCode: "all", minConfidence: 0 }));
  return items.find((i) => i.id === target);
}

/** Simple structured query: filter nodes by kind, layer, id prefix, text, or edge. */
export function query(
  graph: Graph,
  q: { kind?: string; layer?: string; prefix?: string; text?: string; edge?: string; to?: string; limit?: number },
) {
  let nodes = graph.nodes();
  if (q.kind) nodes = nodes.filter((n) => n.kind === q.kind);
  if (q.layer) nodes = nodes.filter((n) => n.layer === q.layer);
  if (q.prefix) nodes = nodes.filter((n) => n.id.startsWith(q.prefix!));
  if (q.text) {
    const t = q.text.toLowerCase();
    nodes = nodes.filter(
      (n) =>
        n.id.toLowerCase().includes(t) ||
        n.label?.toLowerCase().includes(t) ||
        (n.value !== undefined && JSON.stringify(n.value).toLowerCase().includes(t)),
    );
  }
  if (q.edge) {
    nodes = nodes.filter((n) => graph.outgoing(n.id).some((e) => e.type === q.edge && (!q.to || e.to === q.to || e.to.startsWith(q.to))));
  }
  return nodes.slice(0, q.limit ?? 200);
}
