import type { CodeConfig } from "../config/schema.js";
import type { Graph } from "../core/graph.js";
import { changedNodesFromGit } from "./diff.js";
import { ingest } from "./ingest.js";

let warnings: string[] = [];

/**
 * Extracts the code layer for every configured scope: files, symbols (with literal values),
 * screens, routes, packages, env vars, feature flags, analytics events, localization keys,
 * tests, and the edges between them, plus `@starchart` annotation edges.
 */
export async function ingestCode(root: string, config: CodeConfig): Promise<Graph> {
  const result = await ingest(root, config);
  warnings = result.warnings;
  return result.graph;
}

/** Warnings from the most recent {@link ingestCode} call (unknown annotation verbs, unparsable files, ...). */
export function lastIngestWarnings(): string[] {
  return [...warnings];
}

/** Maps `git diff <base>` hunks (and untracked files) to changed code node ids. */
export async function changedNodesFromDiff(root: string, config: CodeConfig, graph: Graph, base: string): Promise<string[]> {
  return changedNodesFromGit(root, config, graph, base);
}
