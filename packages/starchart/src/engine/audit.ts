import { errorMessage, isMissingCredentials } from "../adapters/errors.js";
import { getAdapter } from "../adapters/registry.js";
import { checkPrice, stripeKey } from "../adapters/stripe.js";
import type { Diff } from "../adapters/types.js";
import type { Graph } from "../core/graph.js";
import type { GraphNode } from "../core/model.js";
import type { Project } from "../project.js";
import { adapterContext, mapPool, type EngineIO } from "./context.js";

/**
 * `starchart audit`: the graph versus the live world. Every bound artifact is checked by its
 * adapter, and code that points at world ids (Stripe prices) is verified for break detection.
 */

export interface AuditReport {
  diffs: Diff[];
  errors: { artifact: string; adapter: string; error: string }[];
  /** Artifacts (and code symbols) that were actually checked. */
  checked: string[];
  skipped: { artifact: string; reason: string }[];
}

export interface AuditOptions extends EngineIO {
  /** Limit to these artifact / symbol ids. */
  ids?: string[];
}

const CONCURRENCY = 4;
const PRICE_ID = /^price_[A-Za-z0-9]+$/;

export async function auditProject(project: Project, opts: AuditOptions = {}): Promise<AuditReport> {
  const report: AuditReport = { diffs: [], errors: [], checked: [], skipped: [] };
  const wanted = opts.ids ? new Set(opts.ids) : undefined;

  const runnable: { node: GraphNode; adapterId: string }[] = [];
  for (const node of project.graph.nodes({ kind: "artifact" })) {
    if (wanted && !wanted.has(node.id)) continue;
    const adapterId = node.binding?.adapter;
    if (!adapterId) {
      report.skipped.push({ artifact: node.id, reason: "no binding" });
      continue;
    }
    if (!getAdapter(adapterId)) {
      report.skipped.push({ artifact: node.id, reason: `no adapter "${adapterId}" is registered` });
      continue;
    }
    runnable.push({ node, adapterId });
  }
  runnable.sort((a, b) => a.node.id.localeCompare(b.node.id));

  await mapPool(runnable, CONCURRENCY, async ({ node, adapterId }) => {
    const adapter = getAdapter(adapterId)!;
    try {
      const diffs = await adapter.audit(node, adapterContext(project, adapterId, opts));
      report.checked.push(node.id);
      report.diffs.push(...diffs);
    } catch (e) {
      if (isMissingCredentials(e)) report.skipped.push({ artifact: node.id, reason: e.message });
      else report.errors.push({ artifact: node.id, adapter: adapterId, error: errorMessage(e) });
    }
  });

  await detectBreaks(project, opts, wanted, report);

  report.diffs.sort((a, b) => a.artifact.localeCompare(b.artifact) || (a.fact ?? "").localeCompare(b.fact ?? ""));
  report.checked.sort();
  report.skipped.sort((a, b) => a.artifact.localeCompare(b.artifact));
  return report;
}

/** Facts a code symbol anchors, plus their container ancestors (a stripe artifact may mirror either). */
function anchoredFacts(graph: Graph, symbolId: string): string[] {
  const out = new Set<string>();
  const climb = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    for (const e of graph.outgoing(id, "partOf")) if (graph.node(e.to)?.kind === "fact") climb(e.to);
  };
  for (const e of graph.outgoing(symbolId, "anchors")) if (graph.node(e.to)?.kind === "fact") climb(e.to);
  for (const e of graph.incoming(symbolId, "anchors")) if (graph.node(e.from)?.kind === "fact") climb(e.from);
  return [...out];
}

/** Stripe price ids referenced from code: literal price ids, and prices of stripe artifacts mirroring an anchored fact. */
export function codePriceReferences(graph: Graph): Map<string, GraphNode[]> {
  const refs = new Map<string, GraphNode[]>();
  const add = (price: string, symbol: GraphNode) => {
    const list = refs.get(price) ?? [];
    if (!list.some((s) => s.id === symbol.id)) list.push(symbol);
    refs.set(price, list);
  };
  for (const symbol of graph.nodes({ layer: "code" })) {
    if (typeof symbol.value === "string" && PRICE_ID.test(symbol.value)) {
      add(symbol.value, symbol);
      continue;
    }
    for (const fact of anchoredFacts(graph, symbol.id)) {
      for (const e of graph.incoming(fact, "mirrors")) {
        const artifact = graph.node(e.from);
        const price = artifact?.binding?.price;
        if (artifact?.binding?.adapter === "stripe" && typeof price === "string") add(price, symbol);
      }
    }
  }
  return refs;
}

const locationOf = (node: GraphNode): string | undefined =>
  node.location ? `${node.location.file}${node.location.line ? `:${node.location.line}` : ""}` : undefined;

async function detectBreaks(project: Project, opts: AuditOptions, wanted: Set<string> | undefined, report: AuditReport): Promise<void> {
  const graph = project.graph;
  const refs = [...codePriceReferences(graph)]
    .map(([price, symbols]) => [price, wanted ? symbols.filter((s) => wanted.has(s.id)) : symbols] as const)
    .filter(([, symbols]) => symbols.length > 0);
  if (refs.length === 0) return;

  const ctx = adapterContext(project, "stripe", opts);
  try {
    stripeKey(ctx);
  } catch (e) {
    const reason = `break detection skipped: ${errorMessage(e)}`;
    for (const [, symbols] of refs) for (const s of symbols) report.skipped.push({ artifact: s.id, reason });
    return;
  }

  await mapPool(refs, CONCURRENCY, async ([price, symbols]) => {
    let status: { exists: boolean; active: boolean };
    try {
      status = await checkPrice(price, ctx);
    } catch (e) {
      for (const s of symbols) report.errors.push({ artifact: s.id, adapter: "stripe", error: errorMessage(e) });
      return;
    }
    for (const s of symbols) {
      report.checked.push(s.id);
      if (status.exists && status.active) continue;
      const referencedBy = graph
        .incoming(s.id, "references")
        .map((e) => locationOf(graph.node(e.from) ?? { id: e.from, kind: "symbol", layer: "code" }) ?? e.from);
      report.diffs.push({
        artifact: s.id,
        kind: "break",
        field: "price",
        actual: price,
        message: `Stripe price ${price} ${status.exists ? "is ARCHIVED" : "does not exist"}${referencedBy.length ? `; referenced by ${referencedBy.join(", ")}` : ""}`,
        where: locationOf(s),
      });
    }
  });
}
