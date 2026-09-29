import type { Graph } from "../core/graph.js";
import { computeImpact, type ImpactClass, type ImpactItem } from "../core/impact.js";
import { hasType, isLeafFact, plural } from "../rules/util.js";

/** Coupling heatmap / change-cost advisor: what it costs to change each fact, and how to cut it. */

export interface CostReport {
  id: string;
  impacted: number;
  byClass: Record<ImpactClass, number>;
  /** Estimated person-hours to ship a change to this fact. */
  hours: number;
  /** Hardcoded (non-generated) code anchors. */
  hardcoded: number;
  /** Manual items that are images or videos with the value burned in. */
  mediaBurnIns: number;
  suggestions: string[];
}

export interface CostOptions {
  hours?: Partial<Record<ImpactClass, number>>;
  canWrite?: (adapter: string) => boolean;
}

export const DEFAULT_HOURS: Record<ImpactClass, number> = {
  auto: 0.05,
  code: 0.25,
  test: 0.1,
  review: 0.5,
  manual: 1.5,
  retire: 0.5,
  break: 1,
  info: 0,
};

const MEDIA = ["schema:ImageObject", "schema:VideoObject"];
const CLASSES = Object.keys(DEFAULT_HOURS) as ImpactClass[];

const emptyByClass = (): Record<ImpactClass, number> => ({ auto: 0, code: 0, test: 0, review: 0, manual: 0, retire: 0, break: 0, info: 0 });
const round2 = (n: number): number => Math.round(n * 100) / 100;
const fmtHours = (h: number): string => (h < 1 ? `${Math.round(h * 60)} min` : `${round2(h)} h`);

/**
 * Change cost per fact (default: every leaf fact and every entity), sorted by hours
 * descending. Uses the core impact walk, so costs match what `starchart impact` shows.
 */
export function changeCost(graph: Graph, factIds?: string[], opts: CostOptions = {}): CostReport[] {
  const rates = { ...DEFAULT_HOURS, ...opts.hours };
  const ids =
    factIds ??
    graph
      .nodes()
      .filter((n) => n.kind === "entity" || (isLeafFact(graph, n) && !n.id.endsWith(".status")))
      .map((n) => n.id);
  const reports: CostReport[] = [];
  for (const id of ids) {
    if (!graph.hasNode(id)) continue;
    const { items } = computeImpact(graph, [id], opts.canWrite ? { canWrite: opts.canWrite } : {});
    const byClass = emptyByClass();
    for (const item of items) byClass[item.class]++;
    const hours = round2(CLASSES.reduce((sum, cls) => sum + byClass[cls] * rates[cls], 0));
    // only values embedded in media can move to a template; captured screens need a re-shoot instead
    const media = items.filter((i) => i.class === "manual" && i.via === "embeds" && hasType(i.node, MEDIA));
    const report: CostReport = {
      id,
      impacted: items.length,
      byClass,
      hours,
      hardcoded: byClass.code,
      mediaBurnIns: media.length,
      suggestions: suggest(items, media, byClass, hours, rates),
    };
    reports.push(report);
  }
  return reports.sort((a, b) => b.hours - a.hours || a.id.localeCompare(b.id));
}

function suggest(
  items: ImpactItem[],
  media: ImpactItem[],
  byClass: Record<ImpactClass, number>,
  hours: number,
  rates: Record<ImpactClass, number>,
): string[] {
  const out: string[] = [];
  let saved = 0;
  if (byClass.code > 0) {
    out.push(`${plural(byClass.code, "hardcoded code anchor")}: generate constants with \`starchart codegen\` to make these auto`);
    saved += byClass.code * (rates.code - rates.auto);
  }
  if (media.length > 0) {
    const noun = media.every((m) => hasType(m.node, ["schema:VideoObject"])) ? "video" : media.every((m) => hasType(m.node, ["schema:ImageObject"])) ? "image" : "media asset";
    out.push(`${plural(media.length, noun)} embed${media.length === 1 ? "s" : ""} this value: bind ${media.length === 1 ? "it" : "them"} to a template (renders) to regenerate automatically`);
    saved += media.length * (rates.manual - rates.auto);
  }
  const manual = items.filter((i) => i.class === "manual" && !media.includes(i) && i.via !== "captures");
  const unbound = manual.filter((i) => !i.node.binding);
  const readOnly = manual.filter((i) => i.node.binding);
  if (unbound.length > 0) {
    out.push(`${plural(unbound.length, "artifact")} ${unbound.length === 1 ? "has" : "have"} no binding: bind ${unbound.length === 1 ? "it" : "them"} so STARCHART can audit and update ${unbound.length === 1 ? "it" : "them"}`);
  }
  if (readOnly.length > 0) {
    const adapters = [...new Set(readOnly.map((i) => i.node.binding!.adapter))].sort();
    out.push(`${plural(readOnly.length, "manual update")} in ${adapters.join(", ")}: enable write access for ${adapters.length === 1 ? "this adapter" : "these adapters"} to sync automatically`);
    saved += readOnly.length * (rates.manual - rates.auto);
  }
  if (saved > 0 && hours > 0) out.push(`Doing this cuts the change cost from ${fmtHours(hours)} to ${fmtHours(Math.max(0, hours - saved))}`);
  return out;
}
