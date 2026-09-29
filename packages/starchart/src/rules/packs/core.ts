import type { Graph } from "../../core/graph.js";
import { defineRule, type CustomRule, type Finding, type RulePack } from "../engine.js";
import { deepEqual, formatValue, locationOf, unusedLeafFacts } from "../util.js";

const PACK = "core";
const INACTIVE_STATUSES = new Set(["retired", "deprecated"]);

const artifactBound = defineRule({
  id: "artifact-bound",
  pack: PACK,
  severity: "warn",
  description: "Every world artifact has a binding, so STARCHART can audit and update it",
  select: { kind: "artifact" },
  require: { bound: true },
});

const promoNotExpired = defineRule({
  id: "promo-not-expired",
  pack: PACK,
  severity: "error",
  description: "Artifacts past their validThrough date are retired, not left live",
  select: { kind: "artifact", whereNot: { status: "retired" } },
  require: { notExpired: true },
});

const promotesActive: CustomRule = {
  id: "promotes-active",
  pack: PACK,
  severity: "error",
  description: "Live artifacts never promote a retired or deprecated entity",
  check(graph) {
    const out: Finding[] = [];
    for (const e of graph.edges({ type: "promotes" })) {
      const from = graph.node(e.from);
      const to = graph.node(e.to);
      if (!from || !to || from.status === "retired") continue;
      if (to.status && INACTIVE_STATUSES.has(to.status)) {
        out.push({ node: from.id, message: `${from.id} promotes ${to.id}, which is ${to.status}` });
      }
    }
    return out;
  },
};

const factUsed: CustomRule = {
  id: "fact-used",
  pack: PACK,
  severity: "info",
  description: "Leaf facts that nothing depends on (no code anchor, no artifact)",
  check(graph) {
    return unusedLeafFacts(graph).map((n) => ({ node: n.id, message: `${n.id} is not used by any code or artifact` }));
  },
};

const anchorMatches: CustomRule = {
  id: "anchor-matches",
  pack: PACK,
  severity: "error",
  description: "Hardcoded code literals that anchor a fact still equal the fact value",
  check(graph) {
    const out: Finding[] = [];
    for (const e of graph.edges({ type: "anchors" })) {
      const symbol = graph.node(e.from);
      const fact = graph.node(e.to);
      if (!symbol || !fact || symbol.layer !== "code" || fact.kind !== "fact") continue;
      if (symbol.meta?.generated || symbol.value === undefined || fact.value === undefined) continue;
      if (deepEqual(symbol.value, fact.value)) continue;
      const where = locationOf(symbol);
      out.push({
        node: symbol.id,
        message: `${fact.id}: code says ${formatValue(symbol.value)}, fact says ${formatValue(fact.value)}${where ? ` (${where})` : ""}`,
        file: symbol.location?.file,
      });
    }
    return out;
  },
};

const noDanglingEdge: CustomRule = {
  id: "no-dangling-edge",
  pack: PACK,
  severity: "error",
  description: "Every edge points at nodes that exist",
  check(graph) {
    const out: Finding[] = [];
    for (const e of graph.edges()) {
      const missing = [e.from, e.to].filter((id) => !graph.hasNode(id));
      if (missing.length === 0) continue;
      const anchor = graph.hasNode(e.from) ? e.from : e.to;
      out.push({ node: anchor, message: `${e.from} --${e.type}--> ${e.to}: ${missing.map((m) => `"${m}"`).join(" and ")} does not exist` });
    }
    return out;
  },
};

const anyOwners = (graph: Graph): boolean => graph.nodes().some((n) => n.owners && n.owners.length > 0);

const owners: CustomRule = {
  id: "owners",
  pack: PACK,
  severity: "info",
  description: "Once a project declares owners, every world artifact has one",
  check(graph) {
    if (!anyOwners(graph)) return [];
    return graph
      .nodes({ kind: "artifact" })
      .filter((n) => !(n.owners && n.owners.length > 0))
      .map((n) => ({ node: n.id, message: `${n.id} has no owners` }));
  },
};

export const pack: RulePack = {
  id: PACK,
  description: "Graph hygiene: bindings, expiry, retired promotions, unused facts, code/fact drift, dangling edges, owners",
  rules: [artifactBound, promoNotExpired, promotesActive, factUsed, anchorMatches, noDanglingEdge, owners],
};
