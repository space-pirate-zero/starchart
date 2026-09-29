Everything the CLI does is a function you can call. The CLI, the MCP server, the Claude Code hook and the GitHub Action all sit on the same public API, exported from the package root of `@spz/starchart`. This page lists that API by area with signatures copied from the source, and short examples you can paste into a script, a test, a build step or your own tooling.

Source: [`packages/starchart/src/index.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/index.ts).

## Importing

```ts
import { buildProject, planFromLock, computeImpact, formatPlanMarkdown } from "@spz/starchart";
```

- `@spz/starchart` isn't published to npm yet. Until it is, build from source (`git clone https://github.com/space-pirate-zero/starchart.git && cd starchart && pnpm install && pnpm build`) and depend on the local package, for example `"@spz/starchart": "file:/path/to/starchart/packages/starchart"`.
- ESM only (`"type": "module"`), Node 20+. Types ship in `dist/index.d.ts`.
- The package `exports` map exposes only the root entry (`"." → ./dist/index.js`). Deep imports such as `@spz/starchart/dist/core/graph.js` are blocked by Node's exports resolution. If a helper is not listed below (for example `formatValue`, `discoverChart`, `detectScopes`, `jsonLdContext`), it is internal.
- The MCP server factory is exported as **`createMcpServer`** (it is `createServer` inside `mcp/server.ts`).

## A five-minute tour

```ts
import { buildProject, planFromSeeds, formatPlanText, check, why, explainPath } from "@spz/starchart";

// 1. Load config, compile YAML, ingest code, resolve code facts, read the lock.
const project = await buildProject("./examples/pro-universe");
console.log(project.graph.size);      // { nodes: 111, edges: 182 }
console.log(project.warnings);        // []

// 2. What if the USD price changed?
const plan = planFromSeeds(project, [{ id: "addon:pro.price.usd", before: 4.99, after: 5.99 }]);
console.log(plan.summary);            // { auto: 6, review: 1, manual: 5, retire: 1, break: 0, code: 2, test: 1, info: 5 }
process.stdout.write(formatPlanText(plan, { color: false }));

// 3. Is anything stale right now?
console.log(check(project).length);   // 0

// 4. Why does the OG image depend on the product name?
const item = why(project, "addon:pro.name", "web:og-pro");
console.log(item?.reason, explainPath(item!.path)); // "regenerate from template" …
```

## Project

```ts
export interface Project {
  root: string;
  loaded: LoadedProject;   // { root, config, entities, artifacts, edges, rules }
  graph: Graph;
  lock: LockFile;
  warnings: string[];
}

export interface BuildOptions {
  /** Skip code ingestion (fact + world layers only). */
  skipCode?: boolean;
}

export async function buildProject(start?: string, options: BuildOptions = {}): Promise<Project>
export function readLock(root: string): LockFile
export function writeLock(root: string, lock: LockFile): void
```

`buildProject` finds the nearest ancestor of `start` (default: cwd) that contains `.starchart/`, loads and validates every YAML file there, loads the config's `plugins` (once per process), compiles the fact and world layers, imports design tokens, ingests code (unless `skipCode`), resolves `authority: code` facts, and reads `starchart.lock` (an empty lock when missing). It throws `ConfigError` for a missing `.starchart/`, invalid YAML or config, a plugin that can't be loaded, or a lock that is not version 1. `warnings` holds code-ingestion warnings (the same list `lastIngestWarnings()` returns), unresolved code facts and edges to unknown nodes.

Config values are passed through as written. Nothing is environment-interpolated, so `${VAR}` in `config.yaml` stays the literal string `${VAR}`. Adapters read credentials from `env` themselves.

### Config

```ts
export const STARCHART_DIR = ".starchart";
export const LOCK_FILE = "starchart.lock";
export class ConfigError extends Error { /* file?: string */ }
export function findRoot(start = process.cwd()): string | undefined
export function loadProject(root: string): LoadedProject
export function compileProject(project: LoadedProject): CompileResult
export function resolveCodeFacts(graph: Graph, pending: PendingCodeFact[]): { unresolved: PendingCodeFact[] }
export type { ArtifactDoc, CodeConfig, CodegenTarget, EntityDoc, ProjectConfig }
```

## High-level operations (`api.ts`)

These are what the CLI commands call.

```ts
export interface Change { id: string; before?: unknown; after?: unknown }

export interface Plan {
  changes: Change[];
  impact: ImpactResult;
  steps: OrderedStep[];
  cycles: string[][];
  summary: Record<ImpactItem["class"], number>;
}

export function impactOptions(project: Project, extra: ImpactOptions = {}): ImpactOptions
export function summarize(items: ImpactItem[]): Plan["summary"]
export function planFromSeeds(project: Project, changes: Change[], extra?: ImpactOptions): Plan
export function planFromLock(project: Project, extra?: ImpactOptions): Plan
export async function planFromDiff(project: Project, base: string, extra?: ImpactOptions): Promise<Plan>
export function check(project: Project): StaleArtifact[]
export function resolveRef(project: Project, ref: string, cwd = process.cwd()): string[]
export function why(project: Project, source: string, target: string): ImpactItem | undefined
export function query(
  graph: Graph,
  q: { kind?: string; layer?: string; prefix?: string; text?: string; edge?: string; to?: string; limit?: number },
): GraphNode[]
```

| Function | Does |
|---|---|
| `impactOptions` | the project's impact settings: `maxCodeDepth` from config and `canWrite` from adapter settings, merged with `extra` |
| `planFromSeeds` | impact from explicit seeds, then orders the actionable items (`auto`, `review`, `manual`, `retire`, `break`, `code`) |
| `planFromLock` | seeds = `changedSince(graph, lock)` plus the changed dependencies of every stale artifact; locked artifacts that are already in sync are dropped (what `starchart plan` shows) |
| `planFromDiff` | seeds = git diff nodes + facts changed since the lock ([Git Diff Impact](Git-Diff-Impact)) |
| `check` | `staleArtifacts(graph, lock)` |
| `resolveRef` | exact id → `[id]`; a file path (relative to `cwd`) → the file node plus every symbol it `contains`; otherwise nodes whose id ends with `ref` or `/ref`, or whose label equals it (up to 25) |
| `why` | the impact item for `target` when seeding `source`, walking all code nodes with `minConfidence: 0` |
| `query` | AND of all filters; default limit 200 (the CLI passes 50) |

```ts
const ids = resolveRef(project, "apps/ios/Sources/Core/Pricing.swift", project.root);
// ["file:ios/Sources/Core/Pricing.swift", "symbol:ios/Pricing", "symbol:ios/Pricing.display", "symbol:ios/Pricing.proUSD"]

const anchored = query(project.graph, { edge: "anchors", to: "addon:pro", limit: 10 });
```

## Core graph

### `Graph`

```ts
export class Graph {
  static from(data: SerializedGraph): Graph;
  addNode(node: Omit<GraphNode, "layer"> & { layer?: Layer }): GraphNode;   // merges into an existing id
  addEdge(edge: GraphEdge): GraphEdge;       // duplicate from/type/to keeps higher confidence and stronger origin
  removeEdge(edge: Pick<GraphEdge, "from" | "to" | "type">): void;
  hasNode(id: string): boolean;
  node(id: string): GraphNode | undefined;
  nodes(filter?: { kind?: NodeKind | NodeKind[]; layer?: Layer; prefix?: string }): GraphNode[];
  edges(filter?: { type?: EdgeType | EdgeType[] }): GraphEdge[];
  outgoing(id: string, type?: EdgeType): GraphEdge[];
  incoming(id: string, type?: EdgeType): GraphEdge[];
  get size(): { nodes: number; edges: number };
  merge(other: Graph | SerializedGraph): this;
  toJSON(): SerializedGraph;                 // nodes and edges sorted
}
```

Fact nodes compiled from a fact spec with `description:` carry it as `meta.description`. A declared edge with `confidence: 0` keeps confidence 0 (it isn't reset to 1), which means default impact analysis (`minConfidence: 0.3`) won't walk it.

Model exports: `GraphNode`, `GraphEdge`, `EdgeType`, `EdgeOrigin` (`"declared" | "extracted" | "annotation" | "discovered"`), `NodeKind`, `Layer`, `Binding`, plus `EDGE_TYPES`, `LAYER_OF`, `PROPAGATION`, `BRIDGE_EDGES` and `isEdgeType(value)`. See [Edge Types](Edge-Types) and [Node IDs](Node-IDs).

### Impact

```ts
export type ImpactClass = "auto" | "review" | "manual" | "retire" | "break" | "code" | "test" | "info";

export interface ImpactOptions {
  maxDepth?: number;              // default 12
  maxCodeDepth?: number;          // default 4
  minConfidence?: number;         // default 0.3
  edgeTypes?: EdgeType[];
  includeCode?: "surface" | "all" | "none";   // default "surface"
  canWrite?: (adapter: string, node?: GraphNode) => boolean;   // default: only "fs"
  now?: Date;
}

export function computeImpact(graph: Graph, seeds: string[], options: ImpactOptions = {}): ImpactResult
export function neighbors(graph: Graph, id: string): { edge: GraphEdge; target: string }[]
export function classify(graph: Graph, node: GraphNode, via: EdgeType, path: ImpactHop[], canWrite: (adapter: string, node?: GraphNode) => boolean, now: Date): { cls: ImpactClass; reason: string }
export function explainPath(path: ImpactHop[]): string
```

`computeImpact` is breadth-first, so every item carries its shortest path. `computeImpact` on its own defaults `canWrite` to "fs only"; `impactOptions(project)` gives you the project's real adapter settings. `classify` passes the artifact node to `canWrite`, so an adapter's `canApply(node)` can keep individual artifacts `manual` (App Store screenshots and IAPs, for example).

```ts
import { computeImpact, explainPath } from "@spz/starchart";

for (const i of computeImpact(project.graph, ["screen:ios/Paywall"]).items) {
  console.log(i.class, i.id, explainPath(i.path));
}
// manual appstore:screenshots/6.9/03 screen:ios/Paywall --captures--> appstore:screenshots/6.9/03
// retire reel:spring-2026 screen:ios/Paywall --captures--> reel:spring-2026
// test test:ios/Tests/PaywallTests.swift screen:ios/Paywall --tests--> test:ios/Tests/PaywallTests.swift
```

### Ordering

```ts
export const ADAPTER_PRIORITY: Record<string, number>;
export interface OrderedStep { item: ImpactItem; waitsFor: string[] }
export function orderSteps(graph: Graph, items: ImpactItem[]): { steps: OrderedStep[]; cycles: string[][] }
```

Honors `after` / `blocks` edges, then adapter priority, then id. Cycles are broken deterministically and reported. See [Rollout Ordering](Rollout-Ordering).

### Lock

```ts
export interface LockFile {
  version: 1;
  maxCodeDepth?: number;   // config code.maxCodeDepth, recorded when set
  facts: Record<string, { hash: string; value: unknown }>;
  code: Record<string, string>;
  artifacts: Record<string, { deps: Record<string, string> }>;
}
export interface StaleArtifact { id: string; changed: string[]; unlocked: boolean }

export const emptyLock = (): LockFile
export function stableStringify(value: unknown): string
export const hashValue = (value: unknown): string          // sha1 of stableStringify, 16 hex
export function dependencies(graph: Graph, artifactId: string, maxCodeDepth = 4): string[]
export function buildLock(graph: Graph, previous: LockFile = emptyLock(), artifactIds?: string[], opts: { maxCodeDepth?: number } = {}): LockFile
export function staleArtifacts(graph: Graph, lock: LockFile): StaleArtifact[]
export function changedSince(graph: Graph, lock: LockFile): { id: string; before?: unknown; after?: unknown }[]
```

`buildLock` records `opts.maxCodeDepth` (falling back to `previous.maxCodeDepth`) in the lock and uses it for the dependency walk. `staleArtifacts` walks with the lock's recorded value, so pass the project's setting:

```ts
import { buildLock, writeLock } from "@spz/starchart";
const opts = { maxCodeDepth: project.loaded.config.code.maxCodeDepth };
writeLock(project.root, buildLock(project.graph, project.lock, undefined, opts));   // what `starchart lock` does
```

Pinning only some artifacts is different. `apply`, `ack` and `starchart lock <ids>` use `relockArtifacts(graph, previous, ids, opts)` from `core/lock.ts`, which pins `ids` but keeps the previous value of every fact a still-stale artifact depends on, so those artifacts stay in `plan` and `check` until they're synced or acked. `relockArtifacts` is exported from the package root. A bare `buildLock(graph, lock, ids)` updates every fact value in the lock, which can hide the remaining work from `plan`, so prefer `relockArtifacts` (or `ackArtifacts(project, ids)`, which also writes the lock).

## Code layer and bridges

```ts
export async function ingestCode(root: string, config: CodeConfig): Promise<Graph>
export function lastIngestWarnings(): string[]
export async function changedNodesFromDiff(root: string, config: CodeConfig, graph: Graph, base: string): Promise<string[]>

export async function scanLiterals(root: string, graph: Graph, opts?: { roots?: string[]; exclude?: string[] }): Promise<LiteralOccurrence[]>
export type DiscoveredEdge = GraphEdge & { reason: string };
export function discoverEdges(graph: Graph, occurrences?: LiteralOccurrence[]): DiscoveredEdge[]
export function applyDiscovered(graph: Graph, edges: DiscoveredEdge[], minConfidence = 0.8): GraphEdge[]
```

```ts
import { scanLiterals, discoverEdges, applyDiscovered } from "@spz/starchart";

const occurrences = await scanLiterals(project.root, project.graph, { roots: ["apps", "marketing"] });
const unbound = occurrences.filter((o) => !o.bound);
const added = applyDiscovered(project.graph, discoverEdges(project.graph, occurrences), 0.9);
```

See [Code Ingestion](Code-Ingestion) and [Bridges and Discovery](Bridges-and-Discovery).

## Adapters

```ts
export const builtinAdapters: readonly Adapter[];          // fs, url, stripe, appstore
export function registerAdapter(adapter: Adapter): void
export function getAdapter(id: string): Adapter | undefined
export function listAdapters(): Adapter[]
export function canWrite(id: string, settings?: Record<string, Record<string, unknown>>, node?: GraphNode): boolean
export type { Adapter, AdapterCapabilities, AdapterContext, ApplyResult, Diff, ListedResource, UndoRecord }

export class MissingCredentialsError extends Error {
  constructor(readonly adapter: string, message: string);
}

// text helpers shared by fs, url and appstore
export function leafFacts(graph: Graph, artifactId: string, edgeTypes: EdgeType[] = ["embeds"]): LeafFact[]   // { id, value }
export function findValue(text: string, value: unknown, regions?: Span[]): TokenMatch | undefined            // { start, end, text }
export function auditText(opts: AuditTextOptions): Diff[]
// AuditTextOptions = { artifact, text, facts: LeafFact[], previous: Record<string, unknown>, regions?, where: (index) => string, whereMissing?, field? }
export function planReplacements(facts: LeafFact[], previous: Record<string, unknown>): ReplacementPlan
// ReplacementPlan = { replacements: { fact, from, to }[]; ambiguous: { fact, value, conflictsWith }[]; unplaced: { fact, value }[] }
export function applyReplacements(text: string, replacements: Replacement[], regions?: Span[]): { text: string; count: number; byFact: Record<string, number> }
```

`canWrite` is true only when the adapter declares `write` and implements `apply`, and, when you pass `node`, the adapter's optional `canApply(node)` doesn't return false. Then `fs` writes unless `write: false`, every other adapter only with `write: true`. Throw `MissingCredentialsError` from an adapter's `audit` and the artifact is skipped instead of reported as an error. The `LeafFact`, `Span`, `TokenMatch`, `AuditTextOptions`, `Replacement` and `ReplacementPlan` types aren't exported by name. See [Writing an Adapter](Writing-an-Adapter).

## Engine

```ts
export interface AuditReport {
  diffs: Diff[];
  errors: { artifact: string; adapter: string; error: string }[];
  checked: string[];
  skipped: { artifact: string; reason: string }[];
}
export async function auditProject(project: Project, opts: AuditOptions = {}): Promise<AuditReport>
// AuditOptions = { ids?: string[]; fetch?: typeof fetch; env?: NodeJS.ProcessEnv }

export async function applyPlan(project: Project, plan: Plan, opts: ApplyOptions = {}): Promise<ApplyReport>
// ApplyOptions = { dryRun?: boolean; only?: string[]; onStep?: (e: StepEvent) => void; fetch?; env? }

export async function revertJournal(
  project: Project,
  journalIdOrPath: string,
  opts: EngineIO & { dryRun?: boolean; onStep?: (e: StepEvent) => void } = {},
): Promise<RevertReport>

export async function listJournals(root: string): Promise<JournalSummary[]>
export async function ackArtifacts(project: Project, ids: string[]): Promise<{ acked: string[]; lock: LockFile }>
export async function buildPreview(project: Project, plan: Plan, outDir: string): Promise<{ indexPath: string; entries: PreviewEntry[] }>
```

`ApplyReport` is `{ dryRun, applied, failed?, notRun, pending, bindingEdits, journal?, lockUpdated }`. `fetch` and `env` are injectable for tests.

```ts
import { buildProject, planFromLock, applyPlan } from "@spz/starchart";

const project = await buildProject();
const report = await applyPlan(project, planFromLock(project), {
  dryRun: true,
  onStep: (e) => e.type !== "start" && console.log(e.type, e.id, e.result?.changes ?? e.reason),
});
console.log(report.pending.map((t) => `${t.class} ${t.id}`));
```

See [Apply, Revert and Journals](Apply-Revert-and-Journals) and [Audit and Break Detection](Audit-and-Break-Detection).

## Rules

```ts
export function parseRules(docs: unknown[]): { rules: Rule[]; errors: string[] }
export function defineRule(input: RuleInput): DeclarativeRule
export function evaluateRules(graph: Graph, rules: Rule[], opts: { now?: Date; lock?: LockFile; root?: string } = {}): Violation[]
export const PACKS: Readonly<Record<string, RulePack>>;     // core, appstore, privacy, seo
export function registerPack(pack: RulePack): void          // throws for a built-in id
export function loadPacks(ids: string[]): { rules: Rule[]; unknown: string[] }
export function detectCollection(graph: Graph, catalog?: SdkCatalogEntry[]): DetectedCollection[]
export function parsePrivacyManifest(xml: string): PrivacyManifest

export interface Violation { rule: string; severity: "error" | "warn" | "info"; node: string; message: string; pack?: string; file?: string }
```

`loadPacks` accepts bare ids and published names (`@starchart/pack-seo`, `pack-seo`), and resolves built-in packs first, then registered ones. `registerPack` adds or replaces a non-built-in pack; `registerPack({ id: "core", … })` throws `rule pack "core" is built in and cannot be replaced`. What `starchart rules` does:

```ts
import { parseRules, loadPacks, evaluateRules } from "@spz/starchart";

const { rules, errors } = parseRules(project.loaded.rules);
const packs = loadPacks(project.loaded.config.packs);
const violations = evaluateRules(project.graph, [...packs.rules, ...rules], { lock: project.lock, root: project.root });
```

See [Rules Engine](Rules-Engine).

## Plugins

```ts
export interface StarchartPlugin {
  adapters?: Adapter[];
  packs?: RulePack[];
}
export async function loadPlugins(root: string, specifiers: string[]): Promise<StarchartPlugin[]>
```

`loadPlugins` is what `buildProject` calls with `config.plugins`. Relative specifiers resolve from `root`, bare ones from `root`'s `node_modules`. Each module is imported once per process (keyed by resolved path); its adapters go through `registerAdapter` and its packs through `registerPack`. Problems throw `ConfigError`. You only need it to load plugins outside a project build:

```ts
import { loadPlugins, loadPacks } from "@spz/starchart";

await loadPlugins(process.cwd(), ["./plugins/example.mjs"]);
const { rules, unknown } = loadPacks(["core", "house"]);
```

A plugin module is typed as `StarchartPlugin`. See [Writing an Adapter](Writing-an-Adapter#plugins) and [Rule Packs](Rule-Packs#loading-your-pack-with-plugins).

## Analysis

```ts
export function findOrphans(graph: Graph, listed: Record<string, ListedResource[]> = {}, opts: { now?: Date } = {}): Orphan[]
export function realityScore(graph: Graph, lock: LockFile, opts: { now?: Date; auditDiffs?: Diff[] } = {}): ScoreReport
export function badgeSvg(score: number): string
export function badgeJson(score: number): { schemaVersion: 1; label: string; message: string; color: string }
export const DEFAULT_HOURS: Record<ImpactClass, number>;   // auto 0.05, code 0.25, test 0.1, review 0.5, manual 1.5, retire 0.5, break 1, info 0
export function changeCost(graph: Graph, factIds?: string[], opts: { hours?: Partial<Record<ImpactClass, number>>; canWrite?: (adapter: string) => boolean } = {}): CostReport[]
```

```ts
import { realityScore, badgeSvg, changeCost, impactOptions } from "@spz/starchart";
import { writeFileSync } from "node:fs";

const { score } = realityScore(project.graph, project.lock);          // 83
writeFileSync("reality.svg", badgeSvg(score));
const [top] = changeCost(project.graph, undefined, { canWrite: impactOptions(project).canWrite, hours: { manual: 2 } });
```

## Outputs

### Formatters

```ts
export function formatPlanText(plan: Plan, opts: { color?: boolean; verbose?: boolean } = {}): string
export function formatPlanMarkdown(plan: Plan, opts: { title?: string; maxItems?: number; includeInfo?: boolean } = {}): string
export function formatPlanJson(plan: Plan): PlanJson
export function formatStaleText(stale: readonly StaleArtifact[], opts: { color?: boolean } = {}): string
export function formatStaleMarkdown(stale: readonly StaleArtifact[], opts: { title?: string } = {}): string
```

`formatPlanMarkdown` defaults: title `🌌 STARCHART blast radius`, 50 rows per class, info hidden.

### Codegen, JSON-LD, templates, tokens, history

```ts
export function generateCode(graph: Graph, target: CodegenTarget): string
export function writeCodegen(project: Project): { files: string[]; changed: string[] }

export function toJsonLd(graph: Graph, opts: { ids?: string[]; includeCode?: boolean } = {}): JsonLd
export function schemaOrgFor(graph: Graph, entityId: string): JsonLd | JsonLd[]
export function jsonLdScriptTag(obj: unknown): string

export function renderTemplate(source: string, graph: Graph, extra: Record<string, unknown> = {}, options: RenderOptions = {}): string
export class TemplateError extends Error {}
export async function renderOg(templatePath: string, graph: Graph, outPath: string): Promise<{ bytes: number }>
export function importTokens(graph: Graph, root: string, files: string[]): { count: number }

export async function factHistory(root: string, factId: string, opts: { limit?: number } = {}): Promise<FactVersion[]>
export async function lockAt(root: string, rev: string): Promise<LockFile>
```

See [Codegen](Codegen), [JSON-LD and SEO](JSON-LD-and-SEO), [Design Tokens](Design-Tokens) and [Time Machine](Time-Machine).

## Viewer

```ts
export function viewerData(project: Project): ViewerData
export function renderViewerHtml(data: ViewerData): string
export async function serve(opts: { root?: string; port?: number; host?: string; watch?: boolean } = {}): Promise<ServeHandle>
// ServeHandle = { url: string; close: () => Promise<void> }; defaults: port 4477 (0 = any free port), host 127.0.0.1
export function xrayPayload(project: Project): XrayPayload
```

```ts
import { buildProject, viewerData, renderViewerHtml, serve } from "@spz/starchart";
import { writeFileSync } from "node:fs";

writeFileSync("chart.html", renderViewerHtml(viewerData(await buildProject())));

const server = await serve({ root: ".", port: 0, watch: true });
console.log(server.url);
await server.close();
```

See [Viewer and Serve](Viewer-and-Serve) and [Reality X-Ray](Reality-X-Ray).

## Hooks and MCP

```ts
export async function runClaudeHook(input: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string>
export function claudeHookSettingsSnippet(): {
  hooks: { PostToolUse: { matcher: string; hooks: { type: "command"; command: string }[] }[] };
}
export function createMcpServer(opts: { root?: string } = {}): McpServer
```

`runClaudeHook` takes the hook's stdin JSON and returns the stdout payload (`{"hookSpecificOutput":{…}}`) or `""`. It never throws. `createMcpServer` returns an `McpServer` from `@modelcontextprotocol/sdk`; connect it to any transport. Its root defaults to `$STARCHART_ROOT`, then the cwd.

```ts
import { createMcpServer } from "@spz/starchart";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createMcpServer({ root: "/path/to/repo" });
await server.connect(new StdioServerTransport());
```

See [Claude Code Hook](Claude-Code-Hook) and [MCP Server](MCP-Server).

## Recipes

**Fail a test when a fact drifts from a hardcoded value:**

```ts
import { test, expect } from "vitest";
import { buildProject, scanLiterals } from "@spz/starchart";

test("no unbound fact literals", async () => {
  const project = await buildProject();
  const unbound = (await scanLiterals(project.root, project.graph)).filter((o) => !o.bound);
  expect(unbound.map((o) => `${o.file}:${o.line} ${o.factId}`)).toEqual([]);
});
```

**PR bot without the Action:**

```ts
import { buildProject, planFromDiff, formatPlanMarkdown } from "@spz/starchart";
const project = await buildProject();
const md = formatPlanMarkdown(await planFromDiff(project, "origin/main"), { maxItems: 20 });
```

## See also

- [CLI Reference](CLI-Reference)
- [Architecture](Architecture)
- [Impact Analysis](Impact-Analysis)
- [Writing an Adapter](Writing-an-Adapter)
- [MCP Server](MCP-Server)
