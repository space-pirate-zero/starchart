import type { ListedResource } from "../adapters/types.js";
import type { Graph } from "../core/graph.js";
import type { GraphNode } from "../core/model.js";
import { isExpired, unusedLeafFacts } from "../rules/util.js";

/** Dead stars: things nothing depends on anymore (the reverse of impact). */

export type OrphanKind =
  | "fact-unused"
  | "artifact-unlinked"
  | "flag-unused"
  | "env-unused"
  | "event-unconsumed"
  | "package-unused"
  | "external-unreferenced"
  | "expired";

export interface Orphan {
  id: string;
  kind: OrphanKind;
  message: string;
}

export interface OrphanOptions {
  now?: Date;
}

const KIND_ORDER: OrphanKind[] = [
  "expired",
  "external-unreferenced",
  "artifact-unlinked",
  "fact-unused",
  "package-unused",
  "env-unused",
  "flag-unused",
  "event-unconsumed",
];

const ecosystem = (id: string): string | undefined => /^pkg:([^/]+)\//.exec(id)?.[1];

/**
 * Finds orphans in the graph. `listed` holds adapter `list()` results keyed by adapter id;
 * active external resources no artifact binding (or code literal) refers to are reported.
 */
export function findOrphans(graph: Graph, listed: Record<string, ListedResource[]> = {}, opts: OrphanOptions = {}): Orphan[] {
  const now = opts.now ?? new Date();
  const out: Orphan[] = [];

  for (const fact of unusedLeafFacts(graph)) {
    out.push({ id: fact.id, kind: "fact-unused", message: `${fact.id} is not used by any code or artifact` });
  }

  for (const a of graph.nodes({ kind: "artifact" })) {
    if (graph.outgoing(a.id).length === 0) {
      out.push({ id: a.id, kind: "artifact-unlinked", message: `${a.id} does not embed, render, mirror or describe anything` });
    }
    if (a.status !== "retired" && isExpired(a, now)) {
      out.push({ id: a.id, kind: "expired", message: `${a.id} expired on ${a.validThrough} but is not retired` });
    }
  }

  for (const f of graph.nodes({ kind: "flag" })) {
    if (f.meta?.rollout === 100 || f.meta?.rollout === "100%") {
      out.push({ id: f.id, kind: "flag-unused", message: `${f.id} is rolled out to 100%; remove the flag and its dead branch` });
    }
  }

  for (const env of graph.nodes({ kind: "env" })) {
    if (env.meta?.declaredOnly === true && graph.incoming(env.id).length === 0) {
      out.push({ id: env.id, kind: "env-unused", message: `${env.id} is declared but nothing reads it` });
    }
  }

  // Only meaningful once the project models consumers of events (dashboards, funnels, ...).
  const events = graph.nodes({ kind: "event" });
  const consumed = (ev: GraphNode) => graph.incoming(ev.id).some((e) => e.type !== "emits") || graph.outgoing(ev.id).some((e) => e.type !== "emits");
  if (events.some(consumed)) {
    for (const ev of events.filter((e) => !consumed(e))) {
      out.push({ id: ev.id, kind: "event-unconsumed", message: `${ev.id} is emitted but no dashboard, funnel or artifact consumes it` });
    }
  }

  // Only for ecosystems where the code layer links files to packages, and only direct dependencies.
  const packages = graph.nodes({ kind: "package" });
  const linkedEcosystems = new Set(packages.filter((p) => graph.incoming(p.id, "dependsOn").length > 0).map((p) => ecosystem(p.id)));
  for (const p of packages) {
    if (p.meta?.transitive === true || !linkedEcosystems.has(ecosystem(p.id))) continue;
    if (graph.incoming(p.id, "dependsOn").length === 0) {
      out.push({ id: p.id, kind: "package-unused", message: `${p.id} is a dependency but no file uses it` });
    }
  }

  out.push(...externalUnreferenced(graph, listed));

  return out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.id.localeCompare(b.id));
}

function externalUnreferenced(graph: Graph, listed: Record<string, ListedResource[]>): Orphan[] {
  const out: Orphan[] = [];
  const artifacts = graph.nodes({ kind: "artifact" }).filter((a) => a.binding);
  const literals = new Set(
    graph
      .nodes()
      .filter((n) => n.layer === "code" && typeof n.value === "string")
      .map((n) => n.value as string),
  );
  for (const [adapterId, resources] of Object.entries(listed).sort(([a], [b]) => a.localeCompare(b))) {
    for (const r of resources) {
      if (!r.active) continue;
      const adapter = r.binding.adapter || adapterId;
      const keys = Object.entries(r.binding).filter(([k]) => k !== "adapter");
      const referenced =
        literals.has(r.externalId) ||
        artifacts.some((a) => {
          const b = a.binding!;
          if (b.adapter !== adapter) return false;
          if (Object.entries(b).some(([k, v]) => k !== "adapter" && v === r.externalId)) return true;
          return keys.length > 0 && keys.every(([k, v]) => b[k] === v);
        });
      if (referenced) continue;
      const id = `${adapter}:${r.externalId}`;
      out.push({ id, kind: "external-unreferenced", message: `${adapter} ${r.label} (${r.externalId}) is active but no artifact or code references it` });
    }
  }
  return out;
}
