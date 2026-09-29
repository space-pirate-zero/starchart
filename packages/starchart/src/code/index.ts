import { Graph } from "../core/graph.js";
import type { CodeConfig } from "../config/schema.js";

/**
 * Extracts the code layer for every configured scope.
 * CONTRACT PLACEHOLDER — replaced by the full ingest implementation.
 */
export async function ingestCode(_root: string, _config: CodeConfig): Promise<Graph> {
  return new Graph();
}

/** Maps `git diff <base>` hunks to changed code node ids. */
export async function changedNodesFromDiff(_root: string, _config: CodeConfig, _graph: Graph, _base: string): Promise<string[]> {
  return [];
}
