import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ingestCode } from "./code/index.js";
import { compileProject, resolveCodeFacts, type PendingCodeFact } from "./compiler/compile.js";
import { findRoot, loadProject, LOCK_FILE, ConfigError, type LoadedProject } from "./config/load.js";
import type { Graph } from "./core/graph.js";
import { emptyLock, type LockFile } from "./core/lock.js";
import { importTokens } from "./tokens.js";

export interface Project {
  root: string;
  loaded: LoadedProject;
  graph: Graph;
  lock: LockFile;
  warnings: string[];
}

export interface BuildOptions {
  /** Skip code ingestion (fact + world layers only). */
  skipCode?: boolean;
}

/** Loads config, compiles YAML, ingests code, resolves code-authority facts, and reads the lock. */
export async function buildProject(start?: string, options: BuildOptions = {}): Promise<Project> {
  const root = findRoot(start);
  if (!root) throw new ConfigError(`no .starchart/ found in ${start ?? process.cwd()} or any parent. Run "starchart init".`);
  const loaded = loadProject(root);
  const { graph, pendingCodeFacts, danglingTargets } = compileProject(loaded);
  const warnings: string[] = [];
  if (loaded.config.tokens?.length) importTokens(graph, root, loaded.config.tokens);

  let unresolved: PendingCodeFact[] = pendingCodeFacts;
  if (!options.skipCode) {
    const code = await ingestCode(root, loaded.config.code);
    graph.merge(code);
    unresolved = resolveCodeFacts(graph, pendingCodeFacts).unresolved;
  }
  for (const u of unresolved) warnings.push(`fact ${u.factId}: code symbol ${u.symbol} not found`);
  for (const d of danglingTargets) {
    if (!graph.hasNode(d.to)) warnings.push(`${d.file}: ${d.from} --${d.type}--> ${d.to}: unknown node "${d.to}"`);
  }
  return { root, loaded, graph, lock: readLock(root), warnings };
}

export function readLock(root: string): LockFile {
  const path = join(root, LOCK_FILE);
  if (!existsSync(path)) return emptyLock();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as LockFile;
  if (parsed.version !== 1) throw new ConfigError(`unsupported lock version ${String(parsed.version)}`, LOCK_FILE);
  return { ...emptyLock(), ...parsed };
}

export function writeLock(root: string, lock: LockFile): void {
  writeFileSync(join(root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
}
