import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { errorMessage } from "../adapters/errors.js";
import { canWrite, getAdapter } from "../adapters/registry.js";
import type { ApplyResult, UndoRecord } from "../adapters/types.js";
import type { Plan } from "../api.js";
import { writeCodegen } from "../codegen/index.js";
import { STARCHART_DIR } from "../config/load.js";
import { explainPath, type ImpactItem } from "../core/impact.js";
import { relockArtifacts, type LockFile } from "../core/lock.js";
import { resolveInRoot } from "../paths.js";
import { buildProject, writeLock, type Project } from "../project.js";
import { adapterContext, type EngineIO } from "./context.js";

/**
 * `starchart apply` / `revert` / `ack`: executes the auto steps of a plan through adapters,
 * journals undo records, rewrites stale YAML bindings, and re-pins the lock.
 */

export interface StepEvent {
  type: "start" | "done" | "fail" | "skip";
  id: string;
  adapter?: string;
  result?: ApplyResult;
  reason?: string;
}

export interface PendingTask {
  id: string;
  class: ImpactItem["class"];
  reason: string;
  /** Explanation path from the change to this item. */
  why: string;
}

export interface BindingEdit {
  artifact: string;
  /** Root-relative YAML file. */
  file: string;
  field: string;
  from: string;
  to: string;
  written: boolean;
}

export interface ApplyReport {
  dryRun: boolean;
  applied: ApplyResult[];
  failed?: ApplyResult;
  /** Auto steps not attempted because an earlier step failed. */
  notRun: string[];
  /** Items that need a human (manual, review, retire, break, code) or have no writable adapter. */
  pending: PendingTask[];
  bindingEdits: BindingEdit[];
  /** Root-relative journal path, when anything was written. */
  journal?: string;
  lockUpdated: boolean;
}

export interface ApplyOptions extends EngineIO {
  dryRun?: boolean;
  /** Only run these artifact ids. */
  only?: string[];
  onStep?: (e: StepEvent) => void;
}

export interface JournalEntry {
  artifact: string;
  adapter: string;
  changes: string[];
  undo: UndoRecord;
}

export interface Journal {
  version: 1;
  id: string;
  createdAt: string;
  entries: JournalEntry[];
  bindingEdits: BindingEdit[];
  /** Lock before the apply; restored on revert. */
  lockBefore: LockFile;
  revertedAt?: string;
}

export const JOURNAL_DIR = join(STARCHART_DIR, "journal");

const pendingTask = (item: ImpactItem, reason = item.reason): PendingTask => ({
  id: item.id,
  class: item.class,
  reason,
  why: explainPath(item.path),
});

export async function applyPlan(project: Project, plan: Plan, opts: ApplyOptions = {}): Promise<ApplyReport> {
  const dryRun = opts.dryRun ?? false;
  const only = opts.only ? new Set(opts.only) : undefined;
  const report: ApplyReport = { dryRun, applied: [], notRun: [], pending: [], bindingEdits: [], lockUpdated: false };
  const entries: JournalEntry[] = [];
  const lockBefore = project.lock;
  const emit = (e: StepEvent) => opts.onStep?.(e);
  let codegen: Promise<ApplyResult> | undefined;

  for (const { item } of plan.steps) {
    if (only && !only.has(item.id)) continue;
    const adapterId = item.node.binding?.adapter;
    const adapter = adapterId ? getAdapter(adapterId) : undefined;
    if (item.class !== "auto") {
      report.pending.push(pendingTask(item));
      emit({ type: "skip", id: item.id, adapter: adapterId, reason: item.reason });
      continue;
    }
    if (item.node.layer === "code" && item.node.meta?.generated) {
      // generated fact constants are regenerated in one codegen pass, not per symbol
      if (report.failed) {
        report.notRun.push(item.id);
        continue;
      }
      codegen ??= runCodegen(project, dryRun);
      const result = { ...(await codegen), artifact: item.id };
      if (result.ok) {
        report.applied.push(result);
        emit({ type: "done", id: item.id, adapter: "codegen", result });
      } else {
        report.failed = result;
        emit({ type: "fail", id: item.id, adapter: "codegen", result });
      }
      continue;
    }
    if (!adapterId || !adapter?.apply) {
      const reason = !adapterId ? `${item.reason} (no adapter binding)` : `adapter "${adapterId}" cannot write`;
      report.pending.push(pendingTask(item, reason));
      emit({ type: "skip", id: item.id, adapter: adapterId, reason });
      continue;
    }
    if (report.failed) {
      report.notRun.push(item.id);
      continue;
    }

    emit({ type: "start", id: item.id, adapter: adapterId });
    const node = project.graph.node(item.id) ?? item.node;
    let result: ApplyResult;
    try {
      result = await adapter.apply(node, adapterContext(project, adapterId, { ...opts, dryRun }));
    } catch (e) {
      result = { artifact: item.id, ok: false, changes: [], error: errorMessage(e) };
    }
    if (result.undo && !dryRun) entries.push({ artifact: item.id, adapter: adapterId, changes: result.changes, undo: result.undo });
    if (result.bindingUpdate) report.bindingEdits.push(...(await rewriteBinding(project, item.id, result.bindingUpdate, dryRun)));
    if (result.ok) {
      report.applied.push(result);
      emit({ type: "done", id: item.id, adapter: adapterId, result });
    } else {
      report.failed = result;
      emit({ type: "fail", id: item.id, adapter: adapterId, result });
    }
  }

  if (dryRun) return report;

  const writtenEdits = report.bindingEdits.filter((e) => e.written);
  if (entries.length > 0 || writtenEdits.length > 0) {
    report.journal = await writeJournal(project.root, { entries, bindingEdits: writtenEdits, lockBefore });
  }
  const appliedIds = report.applied.map((r) => r.artifact);
  if (appliedIds.length > 0) {
    // applied writes may have changed code the chart tracks (a bound page is also a route), so
    // re-read the project before pinning; otherwise the artifact is stale against its own edit
    const hasCode = project.graph.nodes({ layer: "code" }).length > 0;
    project.graph = (await buildProject(project.root, { skipCode: !hasCode })).graph;
    // only artifacts are pinned; regenerated code is re-read above and pinned through its artifacts
    const appliedArtifacts = appliedIds.filter((id) => project.graph.node(id)?.kind === "artifact");
    project.lock = relock(project, appliedArtifacts);
    writeLock(project.root, project.lock);
    report.lockUpdated = true;
  }
  return report;
}

/** Regenerates every codegen target once; generated files are reproducible, so they are not journaled. */
async function runCodegen(project: Project, dryRun: boolean): Promise<ApplyResult> {
  if (project.loaded.config.codegen.length === 0) {
    return { artifact: "codegen", ok: false, changes: [], error: "generated constants found but no codegen targets are configured" };
  }
  if (dryRun) {
    // a dry run must refuse what a real run would refuse
    try {
      for (const t of project.loaded.config.codegen) resolveInRoot(project.root, t.out);
    } catch (error) {
      return { artifact: "codegen", ok: false, changes: [], error: errorMessage(error) };
    }
    return { artifact: "codegen", ok: true, changes: [`would regenerate ${project.loaded.config.codegen.map((t) => t.out).join(", ")}`] };
  }
  try {
    const { changed } = writeCodegen(project);
    return { artifact: "codegen", ok: true, changes: changed.length ? changed.map((f) => `regenerated ${f}`) : ["generated constants already current"] };
  } catch (error) {
    return { artifact: "codegen", ok: false, changes: [], error: errorMessage(error) };
  }
}

/** Pins artifacts to the current graph, keeping old fact values that still-stale artifacts need. */
function relock(project: Project, ids: string[]): LockFile {
  return relockArtifacts(project.graph, project.lock, ids, { maxCodeDepth: project.loaded.config.code.maxCodeDepth });
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces `from` with `to` as a whole identifier token in a root-relative file. Returns whether it changed. */
async function replaceIdInFile(root: string, file: string, from: string, to: string, dryRun: boolean): Promise<boolean> {
  let abs: string;
  try {
    abs = resolveInRoot(root, file);
  } catch {
    return false; // a journal or binding pointing outside the project is never rewritten
  }
  if (!existsSync(abs)) return false;
  const text = await readFile(abs, "utf8");
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(from)}(?![A-Za-z0-9_])`, "g");
  if (!re.test(text)) return false;
  if (!dryRun) await writeFile(abs, text.replace(re, to));
  return true;
}

async function rewriteBinding(project: Project, artifactId: string, update: Record<string, unknown>, dryRun: boolean): Promise<BindingEdit[]> {
  const node = project.graph.node(artifactId);
  const file = typeof node?.meta?.file === "string" ? node.meta.file : undefined;
  const edits: BindingEdit[] = [];
  if (!node?.binding || !file) return edits;
  const binding = { ...node.binding };
  for (const [field, value] of Object.entries(update)) {
    const from = binding[field];
    if (typeof from !== "string" || typeof value !== "string" || from === value) continue;
    const written = (await replaceIdInFile(project.root, file, from, value, dryRun)) && !dryRun;
    edits.push({ artifact: artifactId, file, field, from, to: value, written });
    binding[field] = value;
  }
  if (!dryRun) project.graph.addNode({ ...node, binding });
  return edits;
}

async function writeJournal(root: string, body: Pick<Journal, "entries" | "bindingEdits" | "lockBefore">): Promise<string> {
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const journal: Journal = { version: 1, id, createdAt, ...body };
  const dir = join(root, JOURNAL_DIR);
  await mkdir(dir, { recursive: true });
  const rel = join(JOURNAL_DIR, `${id}.json`);
  await writeFile(join(root, rel), `${JSON.stringify(journal, null, 2)}\n`);
  return rel;
}

export interface JournalSummary {
  id: string;
  path: string;
  createdAt: string;
  artifacts: string[];
  revertedAt?: string;
}

/** Journals under `.starchart/journal/`, newest first. */
export async function listJournals(root: string): Promise<JournalSummary[]> {
  const dir = join(root, JOURNAL_DIR);
  if (!existsSync(dir)) return [];
  const out: JournalSummary[] = [];
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".json"))) {
    const path = join(dir, name);
    try {
      const j = JSON.parse(await readFile(path, "utf8")) as Journal;
      out.push({
        id: j.id,
        path,
        createdAt: j.createdAt,
        artifacts: [...new Set([...j.entries.map((e) => e.artifact), ...j.bindingEdits.map((e) => e.artifact)])],
        revertedAt: j.revertedAt,
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

async function resolveJournal(root: string, ref: string): Promise<string> {
  const candidates = [isAbsolute(ref) ? ref : resolve(root, ref), join(root, JOURNAL_DIR, ref), join(root, JOURNAL_DIR, `${ref}.json`)];
  for (const c of candidates) if (existsSync(c) && c.endsWith(".json")) return c;
  const matches = (await listJournals(root)).filter((j) => j.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!.path;
  if (matches.length > 1) throw new Error(`journal "${ref}" is ambiguous: ${matches.map((m) => m.id).join(", ")}`);
  throw new Error(`journal "${ref}" not found in ${JOURNAL_DIR}`);
}

export interface RevertReport {
  journal: string;
  dryRun: boolean;
  results: ApplyResult[];
  ok: boolean;
  bindingEdits: BindingEdit[];
  lockRestored: boolean;
}

/**
 * Applies a journal's undo records in reverse order. Every record is attempted (a partial rollback
 * beats none); the lock is restored and the journal marked reverted only when all succeed.
 */
export async function revertJournal(
  project: Project,
  journalIdOrPath: string,
  opts: EngineIO & { dryRun?: boolean; onStep?: (e: StepEvent) => void } = {},
): Promise<RevertReport> {
  const path = await resolveJournal(project.root, journalIdOrPath);
  const journal = JSON.parse(await readFile(path, "utf8")) as Journal;
  if (journal.revertedAt) throw new Error(`journal ${journal.id} was already reverted at ${journal.revertedAt}`);
  const dryRun = opts.dryRun ?? false;
  const report: RevertReport = { journal: path, dryRun, results: [], ok: true, bindingEdits: [], lockRestored: false };

  for (const entry of [...journal.entries].reverse()) {
    const adapter = getAdapter(entry.adapter);
    opts.onStep?.({ type: "start", id: entry.artifact, adapter: entry.adapter });
    let result: ApplyResult;
    if (!adapter?.revert) {
      result = { artifact: entry.artifact, ok: false, changes: [], error: `adapter "${entry.adapter}" cannot revert` };
    } else {
      try {
        result = await adapter.revert(entry.undo, adapterContext(project, entry.adapter, { ...opts, dryRun }));
      } catch (e) {
        result = { artifact: entry.artifact, ok: false, changes: [], error: errorMessage(e) };
      }
    }
    report.results.push(result);
    if (!result.ok) report.ok = false;
    opts.onStep?.({ type: result.ok ? "done" : "fail", id: entry.artifact, adapter: entry.adapter, result });
  }

  for (const edit of [...journal.bindingEdits].reverse()) {
    const written = (await replaceIdInFile(project.root, edit.file, edit.to, edit.from, dryRun)) && !dryRun;
    report.bindingEdits.push({ ...edit, from: edit.to, to: edit.from, written });
    const node = project.graph.node(edit.artifact);
    if (!dryRun && node?.binding) project.graph.addNode({ ...node, binding: { ...node.binding, [edit.field]: edit.from } });
  }

  if (!dryRun && report.ok) {
    project.lock = journal.lockBefore;
    writeLock(project.root, journal.lockBefore);
    report.lockRestored = true;
    await writeFile(path, `${JSON.stringify({ ...journal, revertedAt: new Date().toISOString() }, null, 2)}\n`);
  }
  return report;
}

/** Marks manual / review items as done: re-pins them to the current graph without touching the world. */
export async function ackArtifacts(project: Project, ids: string[]): Promise<{ acked: string[]; lock: LockFile }> {
  const unknown = ids.filter((id) => project.graph.node(id)?.kind !== "artifact");
  if (unknown.length > 0) throw new Error(`not an artifact: ${unknown.join(", ")}`);
  project.lock = relock(project, ids);
  writeLock(project.root, project.lock);
  return { acked: ids, lock: project.lock };
}
