import type { Graph } from "../core/graph.js";
import type { Binding, GraphNode } from "../core/model.js";

export interface AdapterCapabilities {
  read: boolean;
  write?: boolean;
  dryRun?: boolean;
  rollback?: boolean;
  watch?: boolean;
  /** Can enumerate everything in the external system (for orphan detection). */
  list?: boolean;
}

export interface AdapterContext {
  root: string;
  graph: Graph;
  /** Adapter settings from `.starchart/config.yaml` → adapters.<id>. */
  settings: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  /** Previous fact values from the lock, keyed by fact id (needed to find-and-replace). */
  previousValues: Record<string, unknown>;
  dryRun: boolean;
}

/** One observed mismatch between the graph and the real world. */
export interface Diff {
  artifact: string;
  fact?: string;
  field?: string;
  expected?: unknown;
  actual?: unknown;
  /** "stale": an old value is still present; "missing": the expected value is absent; "break": world state is incompatible. */
  kind: "stale" | "missing" | "mismatch" | "break";
  message: string;
  /** Location detail (file:line, URL, API path). */
  where?: string;
}

export interface ApplyResult {
  artifact: string;
  ok: boolean;
  changes: string[];
  /** Serializable undo record for `starchart revert`. */
  undo?: UndoRecord;
  error?: string;
}

export interface UndoRecord {
  adapter: string;
  artifact: string;
  data: Record<string, unknown>;
}

export interface ListedResource {
  /** Stable external id, e.g. a Stripe price id. */
  externalId: string;
  label: string;
  /** Binding that would refer to this resource. */
  binding: Binding;
  active: boolean;
}

export interface Adapter {
  id: string;
  capabilities: AdapterCapabilities;
  /** Compares the artifact's real-world state with the facts it embeds/mirrors. */
  audit(node: GraphNode, ctx: AdapterContext): Promise<Diff[]>;
  /** Brings the artifact in line with current facts. Required when capabilities.write. */
  apply?(node: GraphNode, ctx: AdapterContext): Promise<ApplyResult>;
  revert?(undo: UndoRecord, ctx: AdapterContext): Promise<ApplyResult>;
  list?(ctx: AdapterContext): Promise<ListedResource[]>;
}
