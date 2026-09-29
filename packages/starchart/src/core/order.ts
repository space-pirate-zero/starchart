import type { Graph } from "./graph.js";
import type { ImpactItem } from "./impact.js";

/**
 * Default rollout priority per adapter: money systems first, then stores, then code,
 * then the public web, then outbound messaging. Lower runs earlier.
 */
export const ADAPTER_PRIORITY: Record<string, number> = {
  stripe: 10,
  revenuecat: 20,
  appstore: 30,
  playstore: 30,
  code: 40,
  fs: 50,
  url: 60,
  cms: 60,
  email: 70,
  youtube: 80,
  tiktok: 80,
};

const priorityOf = (item: ImpactItem): number => {
  if (item.node.layer === "code") return ADAPTER_PRIORITY.code!;
  const adapter = item.node.binding?.adapter;
  return (adapter ? ADAPTER_PRIORITY[adapter] : undefined) ?? 55;
};

export interface OrderedStep {
  item: ImpactItem;
  /** Ids of steps that must finish first. */
  waitsFor: string[];
}

/**
 * Orders actionable impact items for rollout. Honors explicit `after` / `blocks` edges
 * (`A after B` and `B blocks A` both mean B runs first), then adapter priority, then id.
 * Cycles are broken deterministically and reported in `cycles`.
 */
export function orderSteps(graph: Graph, items: ImpactItem[]): { steps: OrderedStep[]; cycles: string[][] } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const deps = new Map<string, Set<string>>();
  for (const id of byId.keys()) deps.set(id, new Set());

  for (const id of byId.keys()) {
    for (const e of graph.outgoing(id, "after")) if (byId.has(e.to)) deps.get(id)!.add(e.to);
    for (const e of graph.outgoing(id, "blocks")) if (byId.has(e.to)) deps.get(e.to)!.add(id);
  }

  const steps: OrderedStep[] = [];
  const done = new Set<string>();
  const cycles: string[][] = [];
  const compare = (a: string, b: string) =>
    priorityOf(byId.get(a)!) - priorityOf(byId.get(b)!) || a.localeCompare(b);

  while (done.size < byId.size) {
    const ready = [...byId.keys()].filter((id) => !done.has(id) && [...deps.get(id)!].every((d) => done.has(d)));
    if (ready.length === 0) {
      const remaining = [...byId.keys()].filter((id) => !done.has(id)).sort(compare);
      cycles.push(remaining);
      const breaker = remaining[0]!;
      steps.push({ item: byId.get(breaker)!, waitsFor: [...deps.get(breaker)!].filter((d) => done.has(d)) });
      done.add(breaker);
      continue;
    }
    ready.sort(compare);
    const next = ready[0]!;
    steps.push({ item: byId.get(next)!, waitsFor: [...deps.get(next)!] });
    done.add(next);
  }
  return { steps, cycles };
}
