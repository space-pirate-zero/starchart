import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import pc from "picocolors";
import { stringify } from "yaml";
import { scanLiterals } from "../bridge/scan.js";
import { STARCHART_DIR } from "../config/load.js";
import type { Graph } from "../core/graph.js";
import { stableStringify } from "../core/lock.js";
import type { GraphNode } from "../core/model.js";
import { buildProject } from "../project.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "DerivedData", "Pods", ".build", ".starchart", "coverage", "vendor", ".turbo", ".gradle"]);
const GENERIC_NAMES = new Set(["app", "src", "source", "sources", "client", "frontend", "mobile"]);

interface Marker {
  dir: string;
  kind: "web" | "node" | "ios" | "android" | "go";
}

/** Directories (depth ≤ 3) that look like an app or package root. */
export function detectScopes(root: string): Record<string, string> {
  const markers: Marker[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const has = (f: string) => entries.includes(f);
    if (has("package.json")) markers.push({ dir, kind: isWebPackage(join(dir, "package.json")) ? "web" : "node" });
    if (has("Package.swift") || has("Package.resolved") || entries.some((e) => e.endsWith(".xcodeproj"))) markers.push({ dir, kind: "ios" });
    if (has("build.gradle") || has("build.gradle.kts")) markers.push({ dir, kind: "android" });
    if (has("go.mod")) markers.push({ dir, kind: "go" });
    if (depth >= 3) return;
    for (const e of entries) {
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const full = join(dir, e);
      try {
        if (readdirSync(full, { withFileTypes: true }) && !e.includes(".")) walk(full, depth + 1);
      } catch {
        // not a directory
      }
    }
  };
  walk(root, 0);

  const dirs = [...new Set(markers.map((m) => m.dir))];
  // drop ancestors (monorepo roots) when they contain app directories
  const leaves = dirs.filter((d) => !dirs.some((other) => other !== d && other.startsWith(`${d}/`)));
  if (leaves.length === 0) return { app: "." };

  const scopes: Record<string, string> = {};
  for (const dir of leaves.sort()) {
    const rel = relative(root, dir) || ".";
    const kind = markers.find((m) => m.dir === dir)!.kind;
    let name = rel === "." ? kind : basename(dir).toLowerCase();
    if (GENERIC_NAMES.has(name) && rel !== ".") name = `${basename(dirname(dir)).toLowerCase()}-${name}`;
    name = name.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || kind;
    let unique = name;
    for (let i = 2; unique in scopes; i++) unique = `${name}${i}`;
    scopes[unique] = rel;
  }
  return scopes;
}

function isWebPackage(path: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return ["next", "react", "vue", "svelte", "astro", "@remix-run/react"].some((d) => d in deps);
  } catch {
    return false;
  }
}

export interface InitOptions {
  discover?: boolean;
  force?: boolean;
  color?: boolean;
}

/** `starchart init`: scaffold `.starchart/` and optionally propose a chart from what's already in the repo. */
export async function runInit(root: string, opts: InitOptions = {}): Promise<string> {
  const c = opts.color ? pc : pc.createColors(false);
  const dir = join(root, STARCHART_DIR);
  const configPath = join(dir, "config.yaml");
  const lines: string[] = [];

  if (existsSync(configPath) && !opts.force) {
    if (!opts.discover) throw new Error(`${relative(root, configPath)} already exists (use --force to overwrite)`);
  } else {
    const scopes = detectScopes(root);
    mkdirSync(join(dir, "entities"), { recursive: true });
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    const config = {
      name: basename(root).toLowerCase(),
      code: { scopes },
      adapters: { fs: {} },
      packs: ["core", "privacy", "appstore", "seo"],
    };
    writeFileSync(
      configPath,
      `# STARCHART config — https://github.com/space-pirate-zero/starchart\n# Adapters that write to external systems (stripe, appstore) are read-only until you set write: true.\n${stringify(config)}`,
    );
    lines.push(`${c.green("✓")} wrote ${relative(root, configPath)}`);
    for (const [name, path] of Object.entries(scopes)) lines.push(`  scope ${c.bold(name)} → ${path}`);
  }

  if (opts.discover) {
    const project = await buildProject(root);
    const proposal = discoverChart(project.graph);
    // scan the whole repo, not just code scopes: marketing copy and emails live elsewhere
    const occurrences = await scanLiterals(root, withProposedFacts(project.graph, proposal), { roots: ["."] });
    const artifacts = proposeArtifacts(occurrences, proposal);
    // proposals stay inert until a human moves them into .starchart/
    mkdirSync(join(dir, "proposals"), { recursive: true });
    const discoveredPath = join(dir, "proposals", "discovered.yaml");
    writeFileSync(discoveredPath, renderDiscovered(proposal, artifacts));
    const { size } = project.graph;
    lines.push(`${c.green("✓")} charted ${size.nodes} nodes / ${size.edges} edges from code`);
    lines.push(
      `${c.green("✓")} proposed ${Object.keys(proposal.facts).length} facts, ${proposal.stripe.length + artifacts.length} artifacts, ${proposal.anchors.length + proposal.stripe.length} bridges → ${relative(root, discoveredPath)}`,
    );
    lines.push(c.dim(`  review it, rename ids, delete what's wrong, move it into ${STARCHART_DIR}/, then run: starchart lock`));
  } else {
    lines.push(c.dim("next: describe your facts in .starchart/entities/, artifacts in .starchart/artifacts/, then run: starchart lock"));
  }
  return lines.join("\n");
}

interface ProposedFact {
  value?: unknown;
  authority?: "code";
  source?: { symbol: string };
  from: string;
  where: string;
}

export interface ChartProposal {
  entity: string;
  facts: Record<string, ProposedFact>;
  anchors: { from: string; to: string }[];
  stripe: { id: string; price: string; symbol: string; where: string }[];
}

const PRICE_NAME = /price|cost|amount|usd|eur|gbp|monthly|yearly|annual/i;
const PRODUCT_NAME = /product|sku|iap|subscription|plan|entitlement/i;
const LIST_NAME = /feature|entitlement|perk|benefit|unlock/i;
const PRODUCT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/i;
const STRIPE_PRICE = /^price_[A-Za-z0-9]{6,}$/;

/**
 * Proposes facts from code constants that look like product facts: prices, product ids,
 * feature lists, and Stripe price ids. Heuristic by design; every item is reviewed in YAML.
 */
export function discoverChart(graph: Graph, entity = "offer:main"): ChartProposal {
  const proposal: ChartProposal = { entity, facts: {}, anchors: [], stripe: [] };
  const taken = new Set<string>();
  const key = (base: string) => {
    let k = base;
    for (let i = 2; taken.has(k); i++) k = `${base}${i}`;
    taken.add(k);
    return k;
  };
  // one fact per distinct value: a second constant holding the same value anchors the same fact
  const byValue = new Map<string, string>();
  const propose = (base: string, value: unknown, fact: Omit<ProposedFact, "from" | "where">, s: GraphNode, where: string, anchor: boolean) => {
    const sig = `${base.split(".")[0]}:${stableStringify(value)}`;
    const existing = byValue.get(sig);
    if (existing) {
      proposal.anchors.push({ from: s.id, to: `${entity}.${existing}` });
      return;
    }
    const k = key(base);
    byValue.set(sig, k);
    proposal.facts[k] = { ...fact, from: s.id, where };
    if (anchor) proposal.anchors.push({ from: s.id, to: `${entity}.${k}` });
  };
  const symbols = graph.nodes({ kind: "symbol" }).filter((s) => s.value !== undefined && !s.meta?.generated);
  for (const s of symbols.sort((a, b) => a.id.localeCompare(b.id))) {
    const name = s.label ?? s.id.split(/[#./]/).pop() ?? s.id;
    const where = s.location ? `${s.location.file}:${s.location.line ?? 1}` : s.id;
    const v = s.value;
    if (typeof v === "string" && STRIPE_PRICE.test(v)) {
      proposal.stripe.push({ id: `stripe:price/${slug(name)}`, price: v, symbol: s.id, where });
    } else if (typeof v === "number" && !Number.isInteger(v) && PRICE_NAME.test(name)) {
      propose(`price${currencySuffix(name)}`, v, { value: v }, s, where, true);
    } else if (typeof v === "string" && PRODUCT_ID.test(v) && PRODUCT_NAME.test(name)) {
      propose("productId", v, { value: v }, s, where, true);
    } else if (Array.isArray(v) && v.length >= 2 && v.every((x) => typeof x === "string") && LIST_NAME.test(name)) {
      propose("features", v, { authority: "code", source: { symbol: s.id.replace(/^symbol:/, "") } }, s, where, false);
    }
  }
  return proposal;
}

function currencySuffix(name: string): string {
  const m = /(usd|eur|gbp|jpy|cad|aud)/i.exec(name);
  return m ? `.${m[1]!.toLowerCase()}` : "";
}

function slug(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "price";
}

/** A copy-free overlay: temporarily adds proposed fact nodes so the literal scanner can find them. */
function withProposedFacts(graph: Graph, proposal: ChartProposal): Graph {
  graph.addNode({ id: proposal.entity, kind: "entity" });
  for (const [k, f] of Object.entries(proposal.facts)) {
    const value = f.value ?? (f.source ? graph.node(`symbol:${f.source.symbol}`)?.value : undefined);
    const node: Omit<GraphNode, "layer"> = { id: `${proposal.entity}.${k}`, kind: "fact", value };
    graph.addNode(node);
    graph.addEdge({ from: node.id, to: proposal.entity, type: "partOf" });
  }
  return graph;
}

const CONTENT_EXT = /\.(tsx|jsx|mdx|md|html|json|xcstrings|strings|xml|txt|ya?ml)$/;

function proposeArtifacts(
  occurrences: Awaited<ReturnType<typeof scanLiterals>>,
  proposal: ChartProposal,
): { id: string; path: string; embeds: string[] }[] {
  const byFile = new Map<string, Set<string>>();
  const factFiles = new Set(Object.values(proposal.facts).map((f) => f.where.split(":")[0]));
  for (const o of occurrences) {
    if (o.bound || !o.factId.startsWith(`${proposal.entity}.`) || !CONTENT_EXT.test(o.file) || factFiles.has(o.file)) continue;
    let set = byFile.get(o.file);
    if (!set) byFile.set(o.file, (set = new Set()));
    set.add(o.factId);
  }
  return [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, facts]) => ({ id: `content:${path.replace(/\.[^.]+$/, "")}`, path, embeds: [...facts].sort() }));
}

function renderDiscovered(proposal: ChartProposal, artifacts: { id: string; path: string; embeds: string[] }[]): string {
  const facts: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(proposal.facts)) {
    const target = k.split(".").reduce<Record<string, unknown>>((obj, part, i, parts) => {
      if (i === parts.length - 1) return obj;
      return (obj[part] ??= {}) as Record<string, unknown>;
    }, facts);
    target[k.split(".").pop()!] = f.authority ? { authority: f.authority, source: f.source } : f.value;
  }
  const doc = {
    entities: Object.keys(facts).length ? [{ id: proposal.entity, type: ["schema:Offer"], label: "Discovered offer — rename me", facts }] : [],
    artifacts: [
      ...proposal.stripe.map((s) => ({ id: s.id, label: `Stripe price referenced at ${s.where}`, binding: { adapter: "stripe", price: s.price } })),
      ...artifacts.map((a) => ({ id: a.id, binding: { adapter: "fs", path: a.path }, embeds: a.embeds })),
    ],
    edges: [
      ...proposal.anchors.map((a) => ({ from: a.from, to: a.to, type: "anchors" })),
      ...proposal.stripe.map((s) => ({ from: s.symbol, to: s.id, type: "anchors" })),
    ],
  };
  const provenance = [
    ...Object.entries(proposal.facts).map(([k, f]) => `#   ${proposal.entity}.${k} ← ${f.where}`),
    ...proposal.stripe.map((s) => `#   ${s.id} ← ${s.where}`),
  ];
  return [
    "# Proposed by `starchart init --discover`. Everything here is a guess: review, rename, delete.",
    "# This file is ignored until you move it into .starchart/ (e.g. .starchart/entities/offer.yaml).",
    "# Where each proposal came from:",
    ...(provenance.length ? provenance : ["#   (nothing found — describe facts by hand in entities/)"]),
    "",
    stringify(doc),
  ].join("\n");
}
