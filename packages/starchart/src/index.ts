/**
 * @space-pirate-zero/starchart — public library API.
 * Everything the CLI, MCP server, hooks and GitHub Action use is exported from here.
 */

// project + high-level operations
export { buildProject, readLock, writeLock, type BuildOptions, type Project } from "./project.js";
export {
  check,
  impactOptions,
  planFromDiff,
  planFromLock,
  planFromSeeds,
  query,
  resolveRef,
  summarize,
  why,
  type Change,
  type Plan,
} from "./api.js";

// config
export { ConfigError, findRoot, loadProject, LOCK_FILE, STARCHART_DIR, type LoadedProject } from "./config/load.js";
export type { ArtifactDoc, CodeConfig, CodegenTarget, EntityDoc, ProjectConfig } from "./config/schema.js";
export { compileProject, resolveCodeFacts, type CompileResult } from "./compiler/compile.js";

// core graph
export { Graph, type SerializedGraph } from "./core/graph.js";
export {
  BRIDGE_EDGES,
  EDGE_TYPES,
  LAYER_OF,
  PROPAGATION,
  isEdgeType,
  type Binding,
  type EdgeOrigin,
  type EdgeType,
  type GraphEdge,
  type GraphNode,
  type Layer,
  type NodeKind,
} from "./core/model.js";
export { classify, computeImpact, explainPath, neighbors, type ImpactClass, type ImpactHop, type ImpactItem, type ImpactOptions, type ImpactResult } from "./core/impact.js";
export { ADAPTER_PRIORITY, orderSteps, type OrderedStep } from "./core/order.js";
export {
  buildLock,
  changedSince,
  dependencies,
  emptyLock,
  hashValue,
  relockArtifacts,
  stableStringify,
  staleArtifacts,
  type LockFile,
  type StaleArtifact,
} from "./core/lock.js";

// code layer + bridges
export { changedNodesFromDiff, ingestCode, lastIngestWarnings } from "./code/index.js";
export { scanLiterals, type LiteralOccurrence } from "./bridge/scan.js";
export { applyDiscovered, discoverEdges, type DiscoveredEdge } from "./bridge/discover.js";

// adapters + engine
export { builtinAdapters, canWrite, getAdapter, listAdapters, registerAdapter } from "./adapters/registry.js";
export type { Adapter, AdapterCapabilities, AdapterContext, ApplyResult, Diff, ListedResource, UndoRecord } from "./adapters/types.js";
export { auditProject, type AuditReport } from "./engine/audit.js";
export { ackArtifacts, applyPlan, listJournals, revertJournal, type ApplyReport } from "./engine/apply.js";
export { buildPreview, type PreviewEntry } from "./engine/preview.js";

// rules + analysis
export { defineRule, evaluateRules, parseRules, type Rule, type RulePack, type Violation } from "./rules/engine.js";
export { loadPacks, PACKS } from "./rules/packs/index.js";
export { detectCollection, parsePrivacyManifest, type DetectedCollection } from "./rules/packs/privacy.js";
export { findOrphans, type Orphan } from "./analysis/orphans.js";
export { badgeJson, badgeSvg, realityScore, type ScoreReport } from "./analysis/score.js";
export { changeCost, DEFAULT_HOURS, type CostReport } from "./analysis/cost.js";

// outputs
export { formatPlanJson, formatPlanMarkdown, formatPlanText, formatStaleMarkdown, formatStaleText } from "./format/plan.js";
export { generateCode, writeCodegen, type CodegenResult } from "./codegen/index.js";
export { jsonLdScriptTag, schemaOrgFor, toJsonLd } from "./render/jsonld.js";
export { renderTemplate, TemplateError } from "./render/template.js";
export { renderOg } from "./render/og.js";
export { importTokens } from "./tokens.js";
export { factHistory, lockAt } from "./history.js";

// plugins
export { loadPlugins, type StarchartPlugin } from "./plugins.js";
export { registerPack } from "./rules/packs/index.js";
export { auditText, findValue, leafFacts, planReplacements, applyReplacements } from "./adapters/text.js";
export { MissingCredentialsError } from "./adapters/errors.js";

// viewer + integrations
export { renderViewerHtml, serve, viewerData, xrayPayload, type ServeHandle, type ViewerData, type XrayPayload } from "./viewer/index.js";
export { claudeHookSettingsSnippet, runClaudeHook } from "./hooks/claude.js";
export { createServer as createMcpServer } from "./mcp/server.js";
