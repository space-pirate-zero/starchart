import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { Command, Option } from "commander";
import pc from "picocolors";
import { canWrite, getAdapter } from "../adapters/registry.js";
import type { ListedResource } from "../adapters/types.js";
import { changeCost } from "../analysis/cost.js";
import { findOrphans } from "../analysis/orphans.js";
import { badgeJson, badgeSvg, realityScore } from "../analysis/score.js";
import { check, impactOptions, planFromDiff, planFromLock, planFromSeeds, query, resolveRef, why, type Plan } from "../api.js";
import { scanLiterals } from "../bridge/scan.js";
import { writeCodegen } from "../codegen/index.js";
import { LOCK_FILE } from "../config/load.js";
import { explainPath, type ImpactItem } from "../core/impact.js";
import { buildLock, relockArtifacts } from "../core/lock.js";
import { adapterContext } from "../engine/context.js";
import { auditProject } from "../engine/audit.js";
import { ackArtifacts, applyPlan, listJournals, revertJournal } from "../engine/apply.js";
import { buildPreview } from "../engine/preview.js";
import { formatPlanJson, formatPlanMarkdown, formatPlanText, formatStaleMarkdown, formatStaleText, formatValue } from "../format/plan.js";
import { factHistory } from "../history.js";
import { claudeHookMain } from "../hooks/claude.js";
import { jsonLdScriptTag, schemaOrgFor, toJsonLd } from "../render/jsonld.js";
import { evaluateRules, parseRules, type Violation } from "../rules/engine.js";
import { loadPacks } from "../rules/packs/index.js";
import { detectCollection } from "../rules/packs/privacy.js";
import { buildProject, writeLock, type Project } from "../project.js";
import { renderViewerHtml, viewerData } from "../viewer/html.js";
import { serve } from "../viewer/serve.js";
import { xrayPayload } from "../viewer/xray.js";
import { runInit } from "./init.js";

type Format = "text" | "markdown" | "json";

interface GlobalOpts {
  cwd?: string;
  color: boolean;
  quiet?: boolean;
}

const VERSION = "0.1.0";

export async function run(argv: string[]): Promise<number> {
  let exitCode = 0;
  const setExit = (code: number) => {
    exitCode = Math.max(exitCode, code);
  };
  const out = (text: string) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);

  const program = new Command()
    .name("starchart")
    .description("Every dependency. Code to cosmos.")
    .version(VERSION)
    .option("-C, --cwd <dir>", "run as if started in <dir>")
    .option("--no-color", "disable colors")
    .option("-q, --quiet", "hide warnings")
    .showHelpAfterError()
    .exitOverride();

  const globals = (): GlobalOpts => program.opts<GlobalOpts>();
  const cwd = () => resolve(globals().cwd ?? process.cwd());
  const color = () => globals().color && process.stdout.isTTY === true && !process.env.NO_COLOR;
  const load = async (opts: { skipCode?: boolean } = {}): Promise<Project> => {
    const project = await buildProject(cwd(), opts);
    if (!globals().quiet) for (const w of project.warnings) process.stderr.write(`${pc.yellow("warn")} ${w}\n`);
    return project;
  };
  const formatOption = (choices: Format[] = ["text", "markdown", "json"]) =>
    new Option("-f, --format <format>", "output format").choices(choices).default("text");
  const printPlan = (plan: Plan, format: Format, verbose = false) => {
    if (format === "json") out(JSON.stringify(formatPlanJson(plan), null, 2));
    else if (format === "markdown") out(formatPlanMarkdown(plan));
    else out(formatPlanText(plan, { color: color(), verbose }));
  };

  program
    .command("init")
    .description("scaffold .starchart/, detect code scopes, and optionally discover facts and bridges")
    .option("--discover", "propose facts, artifacts and bridges found in code and content")
    .option("--force", "overwrite an existing config.yaml")
    .action(async (opts: { discover?: boolean; force?: boolean }) => {
      out(await runInit(cwd(), { discover: opts.discover, force: opts.force, color: color() }));
    });

  program
    .command("impact")
    .description("blast radius of nodes, files, or a git diff across every layer")
    .argument("[refs...]", "node ids, file paths, or unique id suffixes")
    .option("--diff <base>", "use the changes in `git diff <base>` as the seeds")
    .option("--all-code", "report every impacted code node, not just the surface")
    .option("-v, --verbose", "include info items")
    .addOption(formatOption())
    .action(async (refs: string[], opts: { diff?: string; allCode?: boolean; verbose?: boolean; format: Format }) => {
      const project = await load();
      const extra = opts.allCode ? { includeCode: "all" as const } : {};
      let plan: Plan;
      if (opts.diff) {
        plan = await planFromDiff(project, opts.diff, extra);
      } else {
        if (refs.length === 0) throw new Error("give node refs or --diff <base>");
        const seeds = new Set<string>();
        for (const ref of refs) {
          const ids = resolveRef(project, ref, cwd());
          if (ids.length === 0) throw new Error(`no node matches "${ref}". Try "starchart query --text ${ref}".`);
          for (const id of ids) seeds.add(id);
        }
        plan = planFromSeeds(project, [...seeds].map((id) => ({ id })), extra);
      }
      printPlan(plan, opts.format, opts.verbose);
    });

  program
    .command("plan")
    .description("everything changed since starchart.lock, classified and ordered for rollout")
    .option("-v, --verbose", "include info items")
    .addOption(formatOption())
    .action(async (opts: { verbose?: boolean; format: Format }) => {
      const project = await load();
      const plan = planFromLock(project);
      if (plan.changes.length === 0 && opts.format === "text") {
        out(`${pc.green("✓")} no changes since ${LOCK_FILE}`);
        return;
      }
      printPlan(plan, opts.format, opts.verbose);
    });

  program
    .command("apply")
    .description("execute auto steps through adapters, journal undo records, and relock")
    .option("--dry-run", "show what would change without writing")
    .option("-y, --yes", "skip the confirmation prompt")
    .option("--only <ids...>", "only apply these artifacts")
    .action(async (opts: { dryRun?: boolean; yes?: boolean; only?: string[] }) => {
      const project = await load();
      const plan = planFromLock(project);
      const auto = plan.steps.filter((s) => s.item.class === "auto" && (!opts.only || opts.only.includes(s.item.id)));
      if (auto.length === 0) {
        out(`${pc.green("✓")} nothing to apply automatically`);
      } else if (!opts.dryRun && !opts.yes) {
        out(formatPlanText(plan, { color: color() }));
        if (!(await confirm(`Apply ${auto.length} auto step(s)?`))) {
          out("aborted");
          setExit(1);
          return;
        }
      }
      const report = await applyPlan(project, plan, {
        dryRun: opts.dryRun,
        only: opts.only,
        onStep: (e) => {
          if (e.type === "start") return;
          const mark = e.type === "done" ? pc.green("✓") : e.type === "fail" ? pc.red("✗") : pc.dim("·");
          const detail = e.result?.changes.join("; ") || e.result?.error || e.reason || "";
          out(`${mark} ${e.id}${e.adapter ? pc.dim(` [${e.adapter}]`) : ""} ${detail}`);
        },
      });
      for (const edit of report.bindingEdits) {
        out(`${pc.cyan("↻")} ${edit.artifact}: binding ${edit.field} ${edit.from} → ${edit.to}${edit.written ? "" : pc.dim(" (not written)")}`);
      }
      if (report.pending.length) {
        out(`\n${pc.bold("Still needs a human:")}`);
        for (const t of report.pending) out(`  ${classMark(t.class)} ${t.id} ${pc.dim(t.reason)}`);
        if (report.pending.some((t) => project.graph.node(t.id)?.kind === "artifact")) out(pc.dim("  mark artifacts done with: starchart ack <id…>"));
        if (report.pending.some((t) => t.class === "code")) out(pc.dim("  code items: edit the constant, or generate it with starchart codegen"));
      }
      if (report.journal) out(pc.dim(`journal: ${report.journal} (undo with: starchart revert ${report.journal})`));
      if (report.failed) setExit(1);
    });

  program
    .command("revert")
    .description("roll back an apply using its journal")
    .argument("<journal>", "journal id or path (see `starchart journals`)")
    .option("--dry-run", "show what would be reverted")
    .action(async (journal: string, opts: { dryRun?: boolean }) => {
      const project = await load();
      const report = await revertJournal(project, journal, { dryRun: opts.dryRun });
      out(JSON.stringify(report, null, 2));
      if (!report.ok) setExit(1);
    });

  program
    .command("journals")
    .description("list apply journals")
    .action(async () => {
      const project = await load({ skipCode: true });
      const journals = await listJournals(project.root);
      if (journals.length === 0) out("no journals");
      for (const j of journals) out(`${j.id}  ${j.createdAt}  ${j.artifacts.length} artifact(s)${j.revertedAt ? pc.dim(` reverted ${j.revertedAt}`) : ""}`);
    });

  program
    .command("ack")
    .description("mark manual or review items as done (relocks them)")
    .argument("<ids...>", "artifact ids")
    .action(async (ids: string[]) => {
      const project = await load();
      const { acked } = await ackArtifacts(project, ids);
      out(`${pc.green("✓")} acked ${acked.join(", ")}`);
    });

  program
    .command("lock")
    .description("pin every artifact (or the given ones) to the current facts and code")
    .argument("[ids...]", "only relock these artifacts")
    .action(async (ids: string[]) => {
      const project = await load();
      const opts = { maxCodeDepth: project.loaded.config.code.maxCodeDepth };
      // a partial relock must not forget the old values other stale artifacts still need
      const lock = ids.length ? relockArtifacts(project.graph, project.lock, ids, opts) : buildLock(project.graph, project.lock, undefined, opts);
      writeLock(project.root, lock);
      out(`${pc.green("✓")} ${LOCK_FILE}: ${Object.keys(lock.artifacts).length} artifacts, ${Object.keys(lock.facts).length} facts, ${Object.keys(lock.code).length} code pins`);
    });

  program
    .command("check")
    .description("exit 1 when any artifact is stale against starchart.lock (CI gate)")
    .addOption(formatOption())
    .action(async (opts: { format: Format }) => {
      const project = await load();
      const stale = check(project);
      if (opts.format === "json") out(JSON.stringify(stale, null, 2));
      else if (opts.format === "markdown") out(formatStaleMarkdown(stale));
      else out(stale.length ? formatStaleText(stale, { color: color() }) : `${pc.green("✓")} every artifact is in sync`);
      if (stale.length) setExit(1);
    });

  program
    .command("audit")
    .description("compare the chart with live systems and detect breaks")
    .option("--ids <ids...>", "only these artifacts or symbols")
    .addOption(formatOption())
    .action(async (opts: { ids?: string[]; format: Format }) => {
      const project = await load();
      const report = await auditProject(project, { ids: opts.ids });
      if (opts.format === "json") out(JSON.stringify(report, null, 2));
      else if (opts.format === "markdown") out(auditMarkdown(report));
      else {
        for (const d of report.diffs) {
          const mark = d.kind === "break" ? pc.red("✗ break ") : d.kind === "stale" ? pc.yellow("! stale ") : pc.yellow("? " + d.kind.padEnd(7));
          out(`${mark} ${d.artifact}${d.where ? pc.dim(` ${d.where}`) : ""}  ${d.message}`);
        }
        for (const e of report.errors) out(`${pc.red("error")} ${e.artifact} [${e.adapter}] ${e.error}`);
        for (const s of report.skipped) out(pc.dim(`skip  ${s.artifact}: ${s.reason}`));
        out(`${report.checked.length} checked · ${report.diffs.length} diff(s) · ${report.errors.length} error(s) · ${report.skipped.length} skipped`);
      }
      if (report.diffs.length || report.errors.length) setExit(1);
    });

  program
    .command("rules")
    .description("evaluate invariants from .starchart and the configured rule packs")
    .addOption(formatOption())
    .action(async (opts: { format: Format }) => {
      const project = await load();
      const violations = evaluateProjectRules(project);
      if (opts.format === "json") out(JSON.stringify(violations, null, 2));
      else if (opts.format === "markdown") out(violationsMarkdown(violations));
      else out(violationsText(violations, color()));
      if (violations.some((v) => v.severity === "error")) setExit(1);
    });

  program
    .command("privacy")
    .description("data collected by SDKs in code vs. what your privacy disclosures declare")
    .action(async () => {
      const project = await load();
      const collected = detectCollection(project.graph);
      if (collected.length === 0) out("no data-collecting SDKs detected");
      for (const c of collected) {
        out(`${pc.bold(c.sdk)} ${pc.dim(c.package)} [${c.platforms.join(", ")}]${c.tracking ? pc.red(" tracking") : ""}`);
        out(`  collects: ${c.dataTypes.join(", ") || "—"}${c.optionalDataTypes.length ? pc.dim(`  (optional: ${c.optionalDataTypes.join(", ")})`) : ""}`);
      }
      if (!project.loaded.config.packs.some((p) => /(^|\/|-)privacy$/.test(p))) {
        out(`\n${pc.yellow("!")} the privacy rule pack is not enabled; add "privacy" to packs in .starchart/config.yaml to check disclosures`);
        return;
      }
      const violations = evaluateProjectRules(project).filter((v) => v.pack === "privacy");
      if (violations.length) {
        out("");
        out(violationsText(violations, color()));
        if (violations.some((v) => v.severity === "error")) setExit(1);
      } else if (collected.length) out(`\n${pc.green("✓")} every collected data type is disclosed`);
    });

  program
    .command("orphans")
    .description("dead stars: things nothing depends on anymore")
    .option("--external", "also list resources in external systems (e.g. Stripe prices) that nothing references")
    .addOption(formatOption(["text", "json"]))
    .action(async (opts: { external?: boolean; format: Format }) => {
      const project = await load();
      const listed: Record<string, ListedResource[]> = {};
      if (opts.external) {
        const used = new Set(project.graph.nodes({ kind: "artifact" }).map((n) => n.binding?.adapter).filter((a): a is string => !!a));
        for (const id of used) {
          const adapter = getAdapter(id);
          if (!adapter?.list || !adapter.capabilities.list) continue;
          try {
            listed[id] = await adapter.list(adapterContext(project, id));
          } catch (error) {
            process.stderr.write(`${pc.yellow("warn")} ${id}: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
      }
      const orphans = findOrphans(project.graph, listed);
      if (opts.format === "json") out(JSON.stringify(orphans, null, 2));
      else if (orphans.length === 0) out(`${pc.green("✓")} no orphans`);
      else for (const o of orphans) out(`${pc.dim(o.kind.padEnd(22))} ${o.id}  ${o.message}`);
    });

  program
    .command("score")
    .description("Reality Score: % of world artifacts that are bound, in sync and fresh")
    .option("--badge <file>", "write a README badge SVG")
    .option("--badge-json <file>", "write a shields.io endpoint JSON")
    .option("--audit", "include live audit results (slower, needs credentials)")
    .addOption(formatOption(["text", "json"]))
    .action(async (opts: { badge?: string; badgeJson?: string; audit?: boolean; format: Format }) => {
      const project = await load();
      const auditDiffs = opts.audit ? (await auditProject(project)).diffs : undefined;
      const report = realityScore(project.graph, project.lock, { auditDiffs });
      if (opts.badge) writeOut(resolve(cwd(), opts.badge), badgeSvg(report.score));
      if (opts.badgeJson) writeOut(resolve(cwd(), opts.badgeJson), `${JSON.stringify(badgeJson(report.score))}\n`);
      if (opts.format === "json") {
        out(JSON.stringify(report, null, 2));
        return;
      }
      const tint = report.score >= 95 ? pc.green : report.score >= 80 ? pc.yellow : pc.red;
      out(`${pc.bold("reality")} ${tint(`${report.score}%`)}  ${report.inSync}/${report.total} artifacts in sync`);
      for (const [key, ids] of Object.entries(report.breakdown)) if (ids.length) out(`  ${key.padEnd(12)} ${ids.join(", ")}`);
    });

  program
    .command("cost")
    .description("change-cost heatmap: what it costs to change each fact, and how to cut it")
    .argument("[facts...]", "fact or entity ids (default: all)")
    .option("-n, --top <n>", "show the top N", "15")
    .addOption(formatOption(["text", "json"]))
    .action(async (facts: string[], opts: { top: string; format: Format }) => {
      const project = await load();
      const reports = changeCost(project.graph, facts.length ? facts : undefined, { canWrite: impactOptions(project).canWrite });
      const top = reports.slice(0, Number(opts.top));
      if (opts.format === "json") {
        out(JSON.stringify(top, null, 2));
        return;
      }
      const max = Math.max(...top.map((r) => r.hours), 0.01);
      for (const r of top) {
        const bar = "█".repeat(Math.max(1, Math.round((r.hours / max) * 20)));
        out(`${pc.magenta(bar.padEnd(20))} ${r.hours.toFixed(1).padStart(5)}h  ${r.id} ${pc.dim(`(${r.impacted} impacted)`)}`);
        for (const s of r.suggestions) out(pc.dim(`      → ${s}`));
      }
    });

  program
    .command("why")
    .description("explain exactly why <to> depends on <from>")
    .argument("<from>")
    .argument("<to>")
    .action(async (from: string, to: string) => {
      const project = await load();
      const sources = resolveRef(project, from, cwd());
      const targets = resolveRef(project, to, cwd());
      if (!sources.length || !targets.length) throw new Error(`unknown node: ${!sources.length ? from : to}`);
      // a file path resolves to the file and its symbols: take the shortest explanation from any of them
      const item = sources
        .flatMap((s) => targets.map((t) => why(project, s, t)))
        .filter((i): i is ImpactItem => i !== undefined)
        .sort((a, b) => a.depth - b.depth)[0];
      if (!item) {
        out(`${targets.join(", ")} does not depend on ${from}`);
        setExit(1);
        return;
      }
      out(explainPath(item.path));
      out(pc.dim(`class ${item.class} · confidence ${item.confidence} · ${item.reason}`));
    });

  program
    .command("query")
    .description("search the chart")
    .option("--kind <kind>")
    .option("--layer <layer>")
    .option("--prefix <prefix>")
    .option("--text <text>")
    .option("--edge <type>", "nodes with an outgoing edge of this type")
    .option("--to <id>", "…pointing at this id or prefix")
    .option("-n, --limit <n>", "max results", "50")
    .addOption(formatOption(["text", "json"]))
    .action(async (opts: { kind?: string; layer?: string; prefix?: string; text?: string; edge?: string; to?: string; limit: string; format: Format }) => {
      const project = await load();
      const nodes = query(project.graph, { ...opts, limit: Number(opts.limit) });
      if (opts.format === "json") out(JSON.stringify(nodes, null, 2));
      else for (const n of nodes) out(`${layerTint(n.layer)(n.kind.padEnd(8))} ${n.id}${n.value !== undefined ? pc.dim(` = ${formatValue(n.value)}`) : ""}`);
    });

  program
    .command("node")
    .description("inspect one node and its edges")
    .argument("<ref>")
    .action(async (ref: string) => {
      const project = await load();
      const ids = resolveRef(project, ref, cwd());
      if (ids.length !== 1) throw new Error(ids.length ? `ambiguous: ${ids.join(", ")}` : `unknown node: ${ref}`);
      const g = project.graph;
      const node = g.node(ids[0]!)!;
      out(JSON.stringify(node, null, 2));
      for (const e of g.outgoing(node.id)) out(`  --${e.type}--> ${e.to}${e.confidence !== undefined && e.confidence < 1 ? pc.dim(` (${e.confidence})`) : ""}`);
      for (const e of g.incoming(node.id)) out(`  <--${e.type}-- ${e.from}`);
    });

  program
    .command("scan")
    .description("find fact values in code and content that the chart doesn't know about")
    .option("--all", "include bound occurrences")
    .addOption(formatOption(["text", "json"]))
    .action(async (opts: { all?: boolean; format: Format }) => {
      const project = await load();
      const occurrences = (await scanLiterals(project.root, project.graph, { roots: project.loaded.config.content })).filter((o) => opts.all || !o.bound);
      if (opts.format === "json") {
        out(JSON.stringify(occurrences, null, 2));
        return;
      }
      if (occurrences.length === 0) out(`${pc.green("✓")} no unbound fact literals`);
      for (const o of occurrences) out(`${o.bound ? pc.green("bound  ") : pc.yellow("unbound")} ${o.file}:${o.line}  ${pc.bold(o.value)} ${pc.dim(`(${o.factId})`)}  ${pc.dim(o.text)}`);
      if (!opts.all && occurrences.length) setExit(1);
    });

  program
    .command("codegen")
    .description("generate typed fact constants (TS / Swift / Kotlin) from config.codegen")
    .action(async () => {
      const project = await load();
      if (project.loaded.config.codegen.length === 0) throw new Error("no codegen targets in .starchart/config.yaml");
      const result = writeCodegen(project);
      for (const f of result.files) out(`${result.changed.includes(f) ? pc.green("wrote    ") : pc.dim("unchanged")} ${f}`);
    });

  const emit = program.command("emit").description("export the chart");
  emit
    .command("jsonld")
    .description("schema.org JSON-LD for an entity (SEO) or the full chart")
    .option("--entity <id>", "publishable schema.org markup for one entity")
    .option("--script", "wrap in a <script type=application/ld+json> tag")
    .option("--code", "include the code layer in the full export")
    .action(async (opts: { entity?: string; script?: boolean; code?: boolean }) => {
      // always ingest code: code-authority facts get their values from it
      const project = await load();
      const doc = opts.entity ? schemaOrgFor(project.graph, opts.entity) : toJsonLd(project.graph, { includeCode: opts.code });
      out(opts.script ? jsonLdScriptTag(doc) : JSON.stringify(doc, null, 2));
    });
  emit
    .command("graph")
    .description("the raw graph as JSON")
    .action(async () => {
      const project = await load();
      out(JSON.stringify(project.graph.toJSON(), null, 2));
    });
  emit
    .command("xray")
    .description("the X-Ray browser extension payload")
    .action(async () => {
      const project = await load();
      out(JSON.stringify(xrayPayload(project), null, 2));
    });

  program
    .command("preview")
    .description("Future Universe: render the plan's before/after as an HTML report")
    .option("-o, --out <dir>", "output directory", ".starchart/preview")
    .action(async (opts: { out: string }) => {
      const project = await load();
      const plan = planFromLock(project);
      const outDir = resolve(project.root, opts.out);
      const { indexPath, entries } = await buildPreview(project, plan, outDir);
      out(`${pc.green("✓")} ${entries.length} preview entries → ${relative(cwd(), indexPath)}`);
    });

  program
    .command("history")
    .description("time machine: a fact's value across commits")
    .argument("<fact>")
    .option("-n, --limit <n>", "commits to scan", "200")
    .action(async (fact: string, opts: { limit: string }) => {
      const project = await load({ skipCode: true });
      const versions = (await factHistory(project.root, fact, { limit: Number(opts.limit) })).filter((v) => v.value !== undefined);
      if (versions.length === 0) out(`no history for ${fact} (unknown fact, or ${LOCK_FILE} not committed yet)`);
      for (const v of versions) out(`${pc.dim(v.commit.slice(0, 8))} ${v.date.slice(0, 10)} ${pc.bold(formatValue(v.value))}  ${pc.dim(`${v.author}: ${v.subject}`)}`);
    });

  program
    .command("graph")
    .description("write the self-contained interactive star chart")
    .option("-o, --out <file>", "output file", "starchart.html")
    .action(async (opts: { out: string }) => {
      const project = await load();
      const path = resolve(cwd(), opts.out);
      writeOut(path, renderViewerHtml(viewerData(project)));
      out(`${pc.green("✓")} ${relative(cwd(), path)}`);
    });

  program
    .command("serve")
    .description("serve the viewer and the X-Ray API locally")
    .option("-p, --port <port>", "port", "4477")
    .option("--host <host>", "host", "127.0.0.1")
    .option("-w, --watch", "rebuild on file changes")
    .action(async (opts: { port: string; host: string; watch?: boolean }) => {
      const server = await serve({ root: cwd(), port: Number(opts.port), host: opts.host, watch: opts.watch });
      out(`${pc.magenta("★")} STARCHART at ${pc.bold(server.url)}  ${pc.dim("(ctrl+c to stop)")}`);
      await new Promise<void>((done) => {
        const stop = () => void server.close().then(done);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    });

  program
    .command("hook")
    .description("agent hooks")
    .argument("<agent>", "claude")
    .action(async (agent: string) => {
      if (agent !== "claude") throw new Error(`unknown hook target "${agent}" (supported: claude)`);
      await claudeHookMain(process.stdin);
    });

  program
    .command("mcp")
    .description("start the MCP server on stdio")
    .action(async () => {
      const { startStdio } = await import("../mcp/stdio.js");
      // -C wins; otherwise the server resolves $STARCHART_ROOT, then the working directory
      await startStdio(globals().cwd ? cwd() : undefined);
    });

  program
    .command("adapters")
    .description("list adapters and whether they may write")
    .action(async () => {
      const project = await load({ skipCode: true });
      const { listAdapters } = await import("../adapters/registry.js");
      for (const a of listAdapters()) {
        const caps = Object.entries(a.capabilities).filter(([, v]) => v).map(([k]) => k).join(", ");
        const writes = canWrite(a.id, project.loaded.config.adapters);
        out(`${a.id.padEnd(10)} ${writes ? pc.green("writes") : pc.dim("read-only")}  ${pc.dim(caps)}`);
      }
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (isCommanderExit(error)) return error.exitCode;
    throw error;
  }
  return exitCode;
}

export function evaluateProjectRules(project: Project): Violation[] {
  const { rules: declared, errors } = parseRules(project.loaded.rules);
  if (errors.length) throw new Error(`invalid rules:\n  ${errors.join("\n  ")}`);
  const { rules: packRules, unknown } = loadPacks(project.loaded.config.packs);
  if (unknown.length) throw new Error(`unknown rule pack(s): ${unknown.join(", ")}`);
  return evaluateRules(project.graph, [...packRules, ...declared], { lock: project.lock, root: project.root });
}

function violationsText(violations: Violation[], useColor: boolean): string {
  if (violations.length === 0) return `${pc.green("✓")} all rules pass`;
  const c = useColor ? pc : pc.createColors(false);
  const tint = { error: c.red, warn: c.yellow, info: c.dim } as const;
  const lines = violations.map((v) => `${tint[v.severity](v.severity.padEnd(5))} ${c.dim(v.rule)}  ${v.message}${v.file ? c.dim(`  (${v.file})`) : ""}`);
  const counts = (["error", "warn", "info"] as const).map((s) => `${violations.filter((v) => v.severity === s).length} ${s}`).join(" · ");
  return `${lines.join("\n")}\n${counts}`;
}

function auditMarkdown(report: Awaited<ReturnType<typeof auditProject>>): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [`**STARCHART audit:** ${report.checked.length} checked · ${report.diffs.length} diff(s) · ${report.errors.length} error(s) · ${report.skipped.length} skipped`];
  if (report.diffs.length) {
    lines.push("", "| Kind | Artifact | Where | Finding |", "|---|---|---|---|");
    for (const d of report.diffs) lines.push(`| ${d.kind} | \`${d.artifact}\` | ${cell(d.where ?? "")} | ${cell(d.message)} |`);
  }
  if (report.errors.length) {
    lines.push("", "| Artifact | Adapter | Error |", "|---|---|---|");
    for (const e of report.errors) lines.push(`| \`${e.artifact}\` | ${e.adapter} | ${cell(e.error)} |`);
  }
  return lines.join("\n");
}

function violationsMarkdown(violations: Violation[]): string {
  if (violations.length === 0) return "✅ All STARCHART rules pass.";
  const rows = violations.map((v) => `| ${v.severity} | \`${v.rule}\` | ${v.message.replace(/\|/g, "\\|")} |`);
  return ["| Severity | Rule | Finding |", "|---|---|---|", ...rows].join("\n");
}

const CLASS_MARKS: Record<ImpactItem["class"], string> = {
  auto: pc.green("~"),
  review: pc.yellow("?"),
  manual: pc.yellow("!"),
  retire: pc.dim("✗"),
  break: pc.red("✗"),
  code: pc.cyan("⌘"),
  test: pc.magenta("✓"),
  info: pc.dim("·"),
};
const classMark = (cls: ImpactItem["class"]) => CLASS_MARKS[cls];

const layerTint = (layer: string) => (layer === "world" ? pc.magenta : layer === "fact" ? pc.yellow : pc.green);

function writeOut(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function isCommanderExit(error: unknown): error is { exitCode: number; code: string } {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { exitCode?: unknown; code?: unknown };
  return typeof e.exitCode === "number" && typeof e.code === "string" && e.code.startsWith("commander.");
}

