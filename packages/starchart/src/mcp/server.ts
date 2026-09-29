import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { check, planFromDiff, planFromLock, planFromSeeds, query, resolveRef, why, type Plan } from "../api.js";
import type { Graph } from "../core/graph.js";
import { explainPath } from "../core/impact.js";
import type { LockFile } from "../core/lock.js";
import { formatPlanJson, formatPlanMarkdown, formatStaleMarkdown } from "../format/plan.js";
import { buildProject, type Project } from "../project.js";

/**
 * STARCHART as an MCP server: the agent's map of code, facts and the real world.
 * Every call rebuilds the project from disk so answers always reflect the working tree.
 */

export const SERVER_NAME = "starchart";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = `STARCHART charts how code, canonical facts (prices, names, product ids, feature lists) and real-world artifacts (website pages, App Store listings, Stripe prices, screenshots, reels) depend on each other.

How to use it:
- Before editing a fact in .starchart/ or a file that anchors a fact, call starchart_impact with the node id or file path to see the cross-layer blast radius, and tell the user what it touches.
- After making changes, call starchart_plan (changes since starchart.lock) or starchart_diff_impact (changes versus a git base) and fix the "code" and "auto" items in the same session; report "manual", "review" and "break" items to the user.
- Use starchart_why to explain a dependency, starchart_query / starchart_node to explore the graph, starchart_check for drift against the lock, and starchart_audit to compare the graph with live systems.
- starchart_apply writes to external systems and files. It defaults to a dry run. Only call it with dryRun: false and confirm: true after the user has explicitly approved the dry-run plan.`;

export interface ServerOptions {
  /** Project directory (or any directory inside it). Default: $STARCHART_ROOT, then process.cwd(). */
  root?: string;
}

type Format = "markdown" | "json";
const formatSchema = z.enum(["markdown", "json"]).optional().describe('Output format (default "markdown").');

// Minimal shapes of modules loaded on demand (kept local so this server does not hard-depend on them).
interface AuditModule {
  auditProject(project: Project, opts?: { ids?: string[] }): Promise<{
    diffs: { artifact: string; fact?: string; kind: string; message: string; where?: string }[];
    errors: { artifact: string; adapter: string; error: string }[];
    checked: string[];
    skipped: { artifact: string; reason: string }[];
  }>;
}
interface ApplyModule {
  applyPlan(project: Project, plan: Plan, opts?: { dryRun?: boolean; only?: string[] }): Promise<Record<string, unknown>>;
}
interface RulesModule {
  parseRules(docs: unknown[]): { rules: unknown[]; errors: string[] };
  evaluateRules(graph: Graph, rules: unknown[], opts?: { now?: Date; lock?: LockFile; root?: string }): {
    rule: string;
    severity: string;
    node: string;
    message: string;
  }[];
}
interface PacksModule {
  loadPacks(ids: string[]): { rules: unknown[]; unknown: string[] } | unknown[];
}
interface OrphansModule {
  findOrphans(graph: Graph): { id: string; kind: string; message: string }[] | Promise<{ id: string; kind: string; message: string }[]>;
}
interface ScoreModule {
  realityScore(graph: Graph, lock: LockFile): { score: number; total: number; inSync: number; breakdown: Record<string, string[]> };
}

/** Loads an optional sibling module; the specifier is kept non-literal so this file compiles without it. */
async function optionalModule<T>(specifier: string, feature: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (error) {
    throw new Error(`${feature} is not available in this build (${error instanceof Error ? error.message : String(error)})`);
  }
}

const MODULES = {
  audit: "../engine/audit.js",
  apply: "../engine/apply.js",
  rules: "../rules/engine.js",
  packs: "../rules/packs/index.js",
  orphans: "../analysis/orphans.js",
  score: "../analysis/score.js",
} as const;

const text = (body: string): CallToolResult => ({ content: [{ type: "text", text: body }] });
const json = (value: unknown): CallToolResult => text(JSON.stringify(value, null, 2));
const fail = (message: string): CallToolResult => ({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });

function renderPlan(plan: Plan, format: Format | undefined, title: string): CallToolResult {
  return format === "json" ? json(formatPlanJson(plan)) : text(formatPlanMarkdown(plan, { title }));
}

/** Creates the STARCHART MCP server (not yet connected to a transport). */
export function createServer(opts: ServerOptions = {}): McpServer {
  const root = opts.root ?? process.env.STARCHART_ROOT ?? process.cwd();
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const load = () => buildProject(root);

  /** Wraps a handler: builds the project and turns thrown errors into tool errors. */
  const withProject =
    <A>(fn: (project: Project, args: A) => Promise<CallToolResult> | CallToolResult) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        return await fn(await load(), args);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    };

  /** Resolves a reference to exactly one node id or explains why it cannot. */
  const resolveOne = (project: Project, ref: string): string => {
    const ids = resolveRef(project, ref, project.root);
    if (ids.length === 0) throw new Error(`no node matches "${ref}". Try starchart_query with text: "${ref}".`);
    if (ids.length > 1) throw new Error(`"${ref}" is ambiguous; candidates: ${ids.slice(0, 15).join(", ")}`);
    return ids[0]!;
  };

  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    "starchart_impact",
    {
      title: "Cross-layer impact",
      description:
        "Blast radius of changing one node: a fact id (addon:pro.price.usd), a code node, an artifact, or a file path (expands to the file and its symbols). Returns every impacted code surface, fact and world artifact with class (auto/review/manual/retire/break/code/test) and a why-path.",
      inputSchema: {
        ref: z.string().min(1).describe("Node id, file path (absolute or relative to the project root), or unique id suffix."),
        format: formatSchema,
      },
      annotations: readOnly,
    },
    withProject((project, { ref, format }: { ref: string; format?: Format }) => {
      const ids = resolveRef(project, ref, project.root);
      if (ids.length === 0) return fail(`no node matches "${ref}". Try starchart_query with text: "${ref}".`);
      const isFile = ids.some((id) => {
        const kind = project.graph.node(id)?.kind;
        return kind === "file" || kind === "test";
      });
      if (ids.length > 1 && !isFile) return fail(`"${ref}" is ambiguous; candidates: ${ids.slice(0, 15).join(", ")}`);
      const plan = planFromSeeds(project, ids.map((id) => ({ id })));
      return renderPlan(plan, format, `🌌 STARCHART impact of ${ref}`);
    }),
  );

  server.registerTool(
    "starchart_plan",
    {
      title: "Plan changes since the lock",
      description: "Everything that changed since starchart.lock (fact edits, code hashes) and the ordered rollout plan for every impacted artifact.",
      inputSchema: { format: formatSchema },
      annotations: readOnly,
    },
    withProject((project, { format }: { format?: Format }) => renderPlan(planFromLock(project), format, "🌌 STARCHART plan")),
  );

  server.registerTool(
    "starchart_diff_impact",
    {
      title: "Impact of a git diff",
      description: "Cross-layer blast radius of the working tree versus a git base (default origin/main), like the PR comment.",
      inputSchema: {
        base: z.string().min(1).optional().describe('Git base revision (default "origin/main").'),
        format: formatSchema,
      },
      annotations: readOnly,
    },
    withProject(async (project, { base, format }: { base?: string; format?: Format }) => {
      const rev = base ?? "origin/main";
      if (rev.startsWith("-")) return fail(`invalid base "${rev}"`);
      return renderPlan(await planFromDiff(project, rev), format, `🌌 STARCHART blast radius vs ${rev}`);
    }),
  );

  server.registerTool(
    "starchart_check",
    {
      title: "Drift check",
      description: "Artifacts whose pinned facts or code hashes in starchart.lock no longer match the graph (stale), or that were never locked.",
      inputSchema: { format: formatSchema },
      annotations: readOnly,
    },
    withProject((project, { format }: { format?: Format }) => {
      const stale = check(project);
      return format === "json" ? json(stale) : text(formatStaleMarkdown(stale));
    }),
  );

  server.registerTool(
    "starchart_why",
    {
      title: "Explain a dependency",
      description: "Explains why `to` is impacted when `from` changes: the shortest typed edge path between them.",
      inputSchema: {
        from: z.string().min(1).describe("The changing node (id, file path or suffix)."),
        to: z.string().min(1).describe("The impacted node (id or suffix)."),
      },
      annotations: readOnly,
    },
    withProject((project, { from, to }: { from: string; to: string }) => {
      // a file path resolves to the file and its symbols: explain via whichever gives the shortest path
      const sources = resolveRef(project, from, project.root);
      if (sources.length === 0) throw new Error(`no node matches "${from}". Try starchart_query with text: "${from}".`);
      const target = resolveOne(project, to);
      const item = sources
        .map((s) => why(project, s, target))
        .filter((i): i is NonNullable<typeof i> => i !== undefined)
        .sort((a, b) => a.depth - b.depth)[0];
      const source = item?.path[0]?.from ?? sources[0]!;
      if (!item) return text(`${target} does not depend on ${from}: no impact path within the traversal limits.`);
      return text(
        [
          `${target} is impacted by ${source} (${item.class}: ${item.reason}; confidence ${item.confidence}).`,
          "",
          explainPath(item.path),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "starchart_query",
    {
      title: "Query nodes",
      description: "Finds graph nodes by kind (entity, fact, artifact, file, symbol, screen, route, test, ...), layer (code/fact/world), id prefix, free text, or an outgoing edge (edge + optional target prefix `to`).",
      inputSchema: {
        kind: z.string().optional(),
        layer: z.enum(["code", "fact", "world"]).optional(),
        prefix: z.string().optional(),
        text: z.string().optional(),
        edge: z.string().optional().describe("Outgoing edge type, e.g. embeds, mirrors, anchors, captures."),
        to: z.string().optional().describe("With edge: target id or id prefix."),
        limit: z.number().int().positive().max(1000).optional(),
      },
      annotations: readOnly,
    },
    withProject((project, q: { kind?: string; layer?: string; prefix?: string; text?: string; edge?: string; to?: string; limit?: number }) => {
      const nodes = query(project.graph, { ...q, limit: q.limit ?? 100 });
      return json({
        count: nodes.length,
        nodes: nodes.map((n) => {
          const out: Record<string, unknown> = { id: n.id, kind: n.kind, layer: n.layer };
          if (n.label) out.label = n.label;
          if (n.value !== undefined) out.value = n.value;
          return out;
        }),
      });
    }),
  );

  server.registerTool(
    "starchart_node",
    {
      title: "Inspect a node",
      description: "One node with all of its fields and its incoming and outgoing edges.",
      inputSchema: { id: z.string().min(1).describe("Node id (or file path / unique suffix).") },
      annotations: readOnly,
    },
    withProject((project, { id }: { id: string }) => {
      const nodeId = resolveOne(project, id);
      const edge = (e: { from: string; to: string; type: string; confidence?: number; origin?: string }) => ({
        from: e.from,
        to: e.to,
        type: e.type,
        ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
        ...(e.origin ? { origin: e.origin } : {}),
      });
      const sort = <T extends { from: string; to: string; type: string }>(xs: T[]) =>
        [...xs].sort((a, b) => a.type.localeCompare(b.type) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
      return json({
        node: project.graph.node(nodeId),
        outgoing: sort(project.graph.outgoing(nodeId)).map(edge),
        incoming: sort(project.graph.incoming(nodeId)).map(edge),
      });
    }),
  );

  server.registerTool(
    "starchart_audit",
    {
      title: "Audit the real world",
      description: "Compares bound artifacts with live systems through their adapters (files, URLs, Stripe, App Store) and detects breaks such as code referencing archived Stripe prices. Read-only; may call external APIs.",
      inputSchema: { ids: z.array(z.string()).optional().describe("Limit to these artifact / symbol ids.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    withProject(async (project, { ids }: { ids?: string[] }) => {
      const mod = await optionalModule<AuditModule>(MODULES.audit, "audit");
      const report = await mod.auditProject(project, ids ? { ids } : {});
      const lines = [
        `## 🌌 STARCHART audit`,
        "",
        `Checked ${report.checked.length}, skipped ${report.skipped.length}, ${report.diffs.length} diff(s), ${report.errors.length} error(s).`,
        "",
      ];
      for (const d of report.diffs) lines.push(`- **${d.kind}** \`${d.artifact}\`${d.fact ? ` (${d.fact})` : ""}: ${d.message}${d.where ? ` — ${d.where}` : ""}`);
      for (const e of report.errors) lines.push(`- **error** \`${e.artifact}\` (${e.adapter}): ${e.error}`);
      lines.push("", "```json", JSON.stringify(report, null, 2), "```");
      return text(lines.join("\n"));
    }),
  );

  server.registerTool(
    "starchart_rules",
    {
      title: "Evaluate invariants",
      description: "Runs the configured rule packs and the project's own rules (invariants over the graph) and returns violations sorted by severity.",
      inputSchema: {},
      annotations: readOnly,
    },
    withProject(async (project) => {
      const [rulesMod, packsMod] = await Promise.all([
        optionalModule<RulesModule>(MODULES.rules, "rules"),
        optionalModule<PacksModule>(MODULES.packs, "rule packs"),
      ]);
      const packs = packsMod.loadPacks(project.loaded.config.packs);
      const packRules = Array.isArray(packs) ? packs : packs.rules;
      const unknownPacks = Array.isArray(packs) ? [] : packs.unknown;
      const own = rulesMod.parseRules(project.loaded.rules);
      const violations = rulesMod.evaluateRules(project.graph, [...packRules, ...own.rules], {
        now: new Date(),
        lock: project.lock,
        root: project.root,
      });
      return json({ violations, errors: own.errors, unknownPacks, rules: packRules.length + own.rules.length });
    }),
  );

  server.registerTool(
    "starchart_orphans",
    {
      title: "Dead stars",
      description: "Things nothing depends on anymore: unused facts, unlinked artifacts, unused env vars / flags / packages, expired promos.",
      inputSchema: {},
      annotations: readOnly,
    },
    withProject(async (project) => {
      const mod = await optionalModule<OrphansModule>(MODULES.orphans, "orphans");
      const orphans = await mod.findOrphans(project.graph);
      return json({ count: orphans.length, orphans });
    }),
  );

  server.registerTool(
    "starchart_score",
    {
      title: "Reality Score",
      description: "Share of live world artifacts that are bound, in sync with the lock and fresh (0-100), with the breakdown.",
      inputSchema: {},
      annotations: readOnly,
    },
    withProject(async (project) => {
      const mod = await optionalModule<ScoreModule>(MODULES.score, "reality score");
      return json(mod.realityScore(project.graph, project.lock));
    }),
  );

  server.registerTool(
    "starchart_apply",
    {
      title: "Apply the plan",
      description:
        "Executes the plan since the lock: auto steps are written through adapters in rollout order, everything else is returned as pending tasks. DRY RUN BY DEFAULT. Writes happen only with dryRun: false AND confirm: true, which you must only pass after the user explicitly approved the dry-run output.",
      inputSchema: {
        dryRun: z.boolean().optional().describe("Default true. Set false (with confirm: true) to write."),
        confirm: z.boolean().optional().describe("Must be true to execute writes; only after explicit user approval."),
        only: z.array(z.string()).optional().describe("Only run these artifact ids."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    withProject(async (project, { dryRun, confirm, only }: { dryRun?: boolean; confirm?: boolean; only?: string[] }) => {
      const write = dryRun === false && confirm === true;
      const mod = await optionalModule<ApplyModule>(MODULES.apply, "apply");
      const plan = planFromLock(project);
      const report = await mod.applyPlan(project, plan, { dryRun: !write, ...(only ? { only } : {}) });
      const note = write
        ? "Applied (writes executed)."
        : dryRun === false
          ? "Dry run only: writes require confirm: true in addition to dryRun: false, after explicit user approval."
          : "Dry run: nothing was written. Show this to the user; re-run with dryRun: false and confirm: true only after they approve.";
      return text(`${note}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``);
    }),
  );

  return server;
}
