import fg from "fast-glob";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Graph } from "../core/graph.js";
import { leafFacts, LiteralMatcher, normalizeBindingPath, relatedFacts, searchText } from "./literals.js";

export interface LiteralOccurrence {
  factId: string;
  value: string;
  /** Root-relative posix path. */
  file: string;
  line: number;
  /** 1-based column. */
  column: number;
  /** The trimmed line, at most 160 characters. */
  text: string;
  /** Already covered by the chart: a bound artifact embeds it, a symbol in the file anchors it, or the file is generated. */
  bound: boolean;
}

export interface ScanOptions {
  /** Root-relative directories to scan (default: every code scope directory, else the root). */
  roots?: string[];
  /** Extra glob patterns to exclude (relative to each scanned root). */
  exclude?: string[];
}

const SCAN_EXT = ["ts", "tsx", "js", "jsx", "mdx", "md", "html", "json", "yaml", "yml", "swift", "kt", "strings", "xml", "xcstrings", "txt", "css"];
const EXCLUDED_DIRS = [".starchart", "node_modules", "dist", ".git", "build", ".next", "DerivedData", "Pods"];
const LOCKFILES = [
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json", "bun.lock", "Package.resolved", "Gemfile.lock",
  "Cargo.lock", "composer.lock", "Podfile.lock", "gradle.lockfile", "starchart.lock",
];
const MAX_BYTES = 2_000_000;

/** Default scan roots: the scope directories recorded on ingested file nodes. */
function defaultRoots(graph: Graph): string[] {
  const dirs = new Set<string>();
  for (const n of graph.nodes({ kind: ["file", "test"] })) {
    const dir = n.meta?.scopeDir;
    if (typeof dir === "string") dirs.add(dir || ".");
  }
  if (dirs.size === 0 || dirs.has(".")) return ["."];
  return [...dirs].sort();
}

/**
 * Finds every whole-token occurrence of a leaf fact value (strings and numbers) in text files,
 * and says whether the chart already accounts for it.
 */
export async function scanLiterals(root: string, graph: Graph, opts: ScanOptions = {}): Promise<LiteralOccurrence[]> {
  const needles = new Map<string, string[]>();
  for (const fact of leafFacts(graph)) {
    const text = searchText(fact);
    if (text === undefined) continue;
    const list = needles.get(text);
    if (list) list.push(fact.id);
    else needles.set(text, [fact.id]);
  }
  if (needles.size === 0) return [];
  const matcher = new LiteralMatcher(needles.keys());

  const roots = (opts.roots?.length ? opts.roots : defaultRoots(graph)).map((r) => normalizeBindingPath(r) || ".");
  const files = new Set<string>();
  for (const dir of roots) {
    const entries = await fg(`**/*.{${SCAN_EXT.join(",")}}`, {
      cwd: resolve(root, dir),
      ignore: [...EXCLUDED_DIRS.map((d) => `**/${d}/**`), ...LOCKFILES.map((l) => `**/${l}`), ...(opts.exclude ?? [])],
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    });
    for (const e of entries) files.add(dir === "." ? e : `${dir}/${e}`);
  }

  const coverage = new Coverage(graph);
  const out: LiteralOccurrence[] = [];
  for (const file of [...files].sort()) {
    const abs = resolve(root, file);
    let text: string;
    try {
      if ((await stat(abs)).size > MAX_BYTES) continue;
      text = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    const generated = isGenerated(text) || coverage.isGeneratedFile(file);
    let lineStarts: number[] | undefined;
    for (const { index, needle } of matcher.matches(text)) {
      lineStarts ??= computeLineStarts(text);
      const line = lineOf(lineStarts, index);
      const lineStart = lineStarts[line - 1]!;
      const lineEnd = text.indexOf("\n", lineStart);
      const lineText = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim();
      for (const factId of needles.get(needle) ?? []) {
        out.push({
          factId,
          value: needle,
          file,
          line,
          column: index - lineStart + 1,
          text: lineText.length > 160 ? `${lineText.slice(0, 157)}...` : lineText,
          bound: generated || coverage.isBound(file, factId),
        });
      }
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.factId.localeCompare(b.factId));
  return out;
}

function isGenerated(text: string): boolean {
  let end = 0;
  for (let n = 0; n < 5 && end >= 0; n++) end = text.indexOf("\n", end + 1);
  return text.slice(0, end < 0 ? text.length : end).includes("@starchart generated");
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const EMBEDDING_EDGES = ["embeds", "renders", "mirrors"] as const;

/** Answers "does the chart already cover fact F appearing in file P?". */
class Coverage {
  /** file -> artifact ids bound to it (fs binding path or render template). */
  private readonly artifactsByFile = new Map<string, string[]>();
  /** file -> fact ids anchored by a code node located in that file. */
  private readonly anchoredByFile = new Map<string, Set<string>>();
  private readonly generatedFiles = new Set<string>();
  private readonly related = new Map<string, Set<string>>();

  constructor(private readonly graph: Graph) {
    for (const a of graph.nodes({ kind: "artifact" })) {
      const paths: string[] = [];
      if (a.binding?.adapter === "fs" && typeof a.binding.path === "string") paths.push(normalizeBindingPath(a.binding.path));
      if (typeof a.meta?.template === "string") paths.push(normalizeBindingPath(a.meta.template));
      for (const p of paths) {
        const list = this.artifactsByFile.get(p);
        if (list) list.push(a.id);
        else this.artifactsByFile.set(p, [a.id]);
      }
    }
    for (const e of graph.edges({ type: "anchors" })) {
      const from = graph.node(e.from);
      const file = from?.location?.file ?? (typeof from?.meta?.path === "string" ? from.meta.path : undefined);
      if (!file) continue;
      let set = this.anchoredByFile.get(file);
      if (!set) this.anchoredByFile.set(file, (set = new Set()));
      set.add(e.to);
    }
    for (const n of graph.nodes({ kind: ["file", "symbol"] })) {
      if (n.meta?.generated === true) {
        const file = n.location?.file ?? (typeof n.meta.path === "string" ? n.meta.path : undefined);
        if (file) this.generatedFiles.add(file);
      }
    }
  }

  isGeneratedFile(file: string): boolean {
    return this.generatedFiles.has(file);
  }

  private relatedTo(factId: string): Set<string> {
    let set = this.related.get(factId);
    if (!set) this.related.set(factId, (set = relatedFacts(this.graph, factId)));
    return set;
  }

  isBound(file: string, factId: string): boolean {
    const related = this.relatedTo(factId);
    const anchored = this.anchoredByFile.get(file);
    if (anchored) for (const f of anchored) if (related.has(f)) return true;
    for (const artifact of this.artifactsByFile.get(file) ?? []) {
      for (const type of EMBEDDING_EDGES) {
        for (const e of this.graph.outgoing(artifact, type)) if (related.has(e.to)) return true;
      }
    }
    return false;
  }
}
