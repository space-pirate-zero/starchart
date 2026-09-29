import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canWrite } from "../adapters/registry.js";
import type { SerializedGraph } from "../core/graph.js";
import { staleArtifacts } from "../core/lock.js";
import type { Layer } from "../core/model.js";
import type { Project } from "../project.js";
import { impactConfig, unwritableArtifacts, writableAdapters, type ImpactConfig } from "./impact-config.js";

export interface ViewerData {
  name: string;
  graph: SerializedGraph;
  /** Artifact ids whose locked dependencies moved. */
  stale: string[];
  generatedAt: string;
  /** Locked fact values (starchart.lock), shown next to the current value. */
  lockFacts?: Record<string, unknown>;
  /** Adapters that can write (decides auto vs manual in the impact classes). */
  writableAdapters?: string[];
  unwritableArtifacts?: string[];
  /** Project's configured code-hop limit for impact traversal. */
  maxCodeDepth?: number;
  /** Served with live reload (`serve({ watch: true })`): the page listens on /events. */
  live?: boolean;
}

export interface ViewerStats {
  nodes: Record<Layer, number>;
  edges: Record<Layer | "bridge", number>;
  totalNodes: number;
  totalEdges: number;
  stale: number;
}

const LAYERS: readonly Layer[] = ["world", "fact", "code"];

export function computeStats(data: Pick<ViewerData, "graph" | "stale">): ViewerStats {
  const nodes: Record<Layer, number> = { world: 0, fact: 0, code: 0 };
  const edges: Record<Layer | "bridge", number> = { world: 0, fact: 0, code: 0, bridge: 0 };
  const layerOf = new Map<string, Layer>();
  for (const n of data.graph.nodes) {
    nodes[n.layer]++;
    layerOf.set(n.id, n.layer);
  }
  for (const e of data.graph.edges) {
    const a = layerOf.get(e.from);
    const b = layerOf.get(e.to);
    if (a && a === b) edges[a]++;
    else edges.bridge++;
  }
  return {
    nodes,
    edges,
    totalNodes: data.graph.nodes.length,
    totalEdges: data.graph.edges.length,
    stale: data.stale.length,
  };
}

/** Collects everything the viewer needs from a built project. */
export function viewerData(project: Project): ViewerData {
  const graph = project.graph.toJSON();
  const settings = project.loaded.config.adapters;
  const lockFacts: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(project.lock.facts)) lockFacts[id] = entry.value;
  const stale = staleIds(project);
  const data: ViewerData = {
    name: project.loaded.config.name,
    graph,
    stale,
    generatedAt: new Date().toISOString(),
    lockFacts,
    writableAdapters: writableAdapters(graph, (adapter) => canWrite(adapter, settings)),
  };
  data.unwritableArtifacts = unwritableArtifacts(graph, data.writableAdapters!, (adapter, node) => canWrite(adapter, settings, node));
  const maxCodeDepth = project.loaded.config.code.maxCodeDepth;
  if (maxCodeDepth !== undefined) data.maxCodeDepth = maxCodeDepth;
  return data;
}

function staleIds(project: Project): string[] {
  return staleArtifacts(project.graph, project.lock)
    .filter((s) => !s.unlocked)
    .map((s) => s.id);
}

interface Assets {
  css: string;
  impact: string;
  viewer: string;
}

let assetCache: Assets | undefined;

/** Client assets live next to this module (src/viewer/assets in dev, dist/viewer/assets when built). */
function assets(): Assets {
  if (assetCache) return assetCache;
  const read = (file: string) => readFileSync(new URL(`./assets/${file}`, import.meta.url), "utf8");
  assetCache = { css: read("viewer.css"), impact: read("impact-core.js"), viewer: read("viewer.js") };
  return assetCache;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/**
 * JSON safe to embed in `<script type="application/json">`: every `<`, `>` and `&` is
 * escaped as a \u sequence, so no payload can close the element or open a comment.
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Inline script text can never contain a closing tag. */
const inlineScript = (source: string) => source.replace(/<\/(script)/gi, "<\\/$1");

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

const fmt = (n: number) => n.toLocaleString("en-US");

function statsHtml(stats: ViewerStats): string {
  const item = (cls: string, label: string, value: string, title: string) =>
    `<div class="stat ${cls}" title="${escapeHtml(title)}"><dt>${label}</dt><dd>${value}</dd></div>`;
  return [
    item("world", "WORLD", fmt(stats.nodes.world), `${fmt(stats.nodes.world)} world nodes, ${fmt(stats.edges.world)} world edges`),
    item("fact", "FACTS", fmt(stats.nodes.fact), `${fmt(stats.nodes.fact)} fact nodes, ${fmt(stats.edges.fact)} fact edges`),
    item("code", "CODE", fmt(stats.nodes.code), `${fmt(stats.nodes.code)} code nodes, ${fmt(stats.edges.code)} code edges`),
    item("edges", "EDGES", fmt(stats.totalEdges), `${fmt(stats.edges.bridge)} cross-layer bridge edges`),
    item(stats.stale > 0 ? "stale hot" : "stale", "STALE", fmt(stats.stale), `${fmt(stats.stale)} stale artifacts`),
  ].join("");
}

/** Renders the self-contained star chart page (inline CSS and JS, no network dependencies). */
export function renderViewerHtml(data: ViewerData): string {
  const { css, impact, viewer } = assets();
  const stats = computeStats(data);
  const config: ImpactConfig = impactConfig(data.graph, {
    writableAdapters: data.writableAdapters,
    unwritableArtifacts: data.unwritableArtifacts,
    maxCodeDepth: data.maxCodeDepth,
  });
  const payload = {
    name: data.name,
    generatedAt: data.generatedAt,
    graph: data.graph,
    stale: data.stale,
    lockFacts: data.lockFacts ?? {},
    impact: config,
    stats,
    live: data.live === true,
  };
  const impactJs = inlineScript(impact);
  const viewerJs = inlineScript(viewer);
  const csp = [
    "default-src 'none'",
    `script-src ${sha256(impactJs)} ${sha256(viewerJs)}`,
    `style-src ${sha256(css)}`,
    "connect-src 'self'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const name = escapeHtml(data.name);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="color-scheme" content="dark">
<meta name="generator" content="STARCHART">
<title>STARCHART — ${name}</title>
<style>${css}</style>
</head>
<body>
<a class="skip" href="#search">Skip to search</a>
<canvas id="sky" aria-hidden="true"></canvas>
<header class="top">
  <div class="brand">
    <svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1l2.9 7.6L23 9.3l-6.2 5.1L18.9 23 12 18.6 5.1 23l2.1-8.6L1 9.3l8.1-.7z"/></svg>
    <h1>STARCHART <span class="dash">—</span> <span class="project">${name}</span></h1>
  </div>
  <dl class="stats" id="stats" aria-label="Graph statistics">${statsHtml(stats)}</dl>
  <div class="search" role="search">
    <label for="search" class="sr-only">Search nodes by id or label</label>
    <input id="search" type="search" autocomplete="off" spellcheck="false" placeholder="Search stars…" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="search-results">
    <kbd class="hint" aria-hidden="true">/</kbd>
    <ul id="search-results" class="results" role="listbox" aria-label="Search results" hidden></ul>
  </div>
</header>
<nav class="toolbar" aria-label="Chart controls">
  <div class="group" role="group" aria-label="Layers">
    <button type="button" class="chip world" data-layer="world" aria-pressed="true">WORLD</button>
    <button type="button" class="chip fact" data-layer="fact" aria-pressed="true">FACTS</button>
    <button type="button" class="chip code" data-layer="code" aria-pressed="true">CODE</button>
  </div>
  <button type="button" class="toggle" id="toggle-code" aria-pressed="false" title="Also show file and symbol nodes">SHOW ALL CODE</button>
  <button type="button" class="toggle impact" id="toggle-impact" aria-pressed="false" title="Select a star to see its blast radius (I)">IMPACT</button>
  <div class="group zoom" role="group" aria-label="Zoom">
    <button type="button" id="zoom-in" aria-label="Zoom in">+</button>
    <button type="button" id="zoom-out" aria-label="Zoom out">−</button>
    <button type="button" id="zoom-fit" aria-label="Fit chart to screen">FIT</button>
  </div>
  <p class="keys" aria-hidden="true"><kbd>/</kbd> search <kbd>I</kbd> impact <kbd>F</kbd> fit <kbd>N</kbd>/<kbd>P</kbd> next/prev <kbd>Esc</kbd> clear</p>
</nav>
<main class="main">
  <div class="stage" id="stage">
    <canvas id="chart" tabindex="0" role="img" aria-roledescription="star chart" aria-label="Dependency star chart for ${name}: world, facts and code bands. Use search, or N and P to step through stars."></canvas>
    <div id="tooltip" class="tooltip" role="tooltip" hidden></div>
    <div id="status" class="status" role="status" aria-live="polite"></div>
    <aside class="legend" aria-label="Edge types">
      <h2><button type="button" id="legend-toggle" class="legend-toggle" aria-expanded="true" aria-controls="legend">EDGES <span class="caret" aria-hidden="true">▾</span></button></h2>
      <ul id="legend"></ul>
    </aside>
  </div>
  <aside id="panel" class="panel" aria-label="Star details" hidden>
    <div class="panel-bar">
      <button type="button" id="panel-back" class="ghost" aria-label="Back to previous star" hidden>← BACK</button>
      <button type="button" id="panel-close" class="ghost close" aria-label="Close details">×</button>
    </div>
    <div id="panel-body" class="panel-body"></div>
  </aside>
</main>
<div id="announce" class="sr-only" aria-live="polite"></div>
<script type="application/json" id="starchart-data">${safeJson(payload)}</script>
<script>${impactJs}</script>
<script>${viewerJs}</script>
</body>
</html>
`;
}
