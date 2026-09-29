import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { CodeConfig } from "../config/schema.js";
import { Graph } from "../core/graph.js";
import { isEdgeType, type EdgeType, type GraphEdge } from "../core/model.js";
import { annotationTarget, MARKER_VERBS, parseAnnotations, scanTextAnnotations } from "./annotations.js";
import type { ClikeParsed } from "./clike-common.js";
import { discoverFiles, isGeneratedText, type DiscoveredFile } from "./files.js";
import { parseGo } from "./golang.js";
import { parseI18nFile, type I18nEntry } from "./i18n.js";
import { parseKotlin } from "./kotlin.js";
import { npmPackageName, PackageIndex } from "./packages.js";
import { detectRoute, isNextConfig } from "./routes.js";
import { parseSwift } from "./swift.js";
import { loadTsConfig, TsResolver, type TsPathConfig } from "./tsresolve.js";
import type { AnnotationComment, Diagnostics, NameRef, ParsedFile, SymbolDecl } from "./types.js";
import { parseTypeScript, type TsParsed } from "./typescript.js";
import { basenamePosix, dirnamePosix, hashJson, mapLimit, pushMulti, sha16 } from "./util.js";

const MAX_CODE_BYTES = 2_000_000;
const MAX_TEXT_BYTES = 1_000_000;

export interface IngestResult {
  graph: Graph;
  warnings: string[];
}

/** A non-code file that only contributes annotations (markdown, html, yaml, mdx, ...). */
interface PlainFile {
  file: DiscoveredFile;
  hash: string;
  generated: boolean;
  annotations: AnnotationComment[];
}

interface I18nFile {
  file: DiscoveredFile;
  hash: string;
  entries: I18nEntry[];
}

const fileNodeId = (f: { scope: string; rel: string }) => `file:${f.scope}/${f.rel}`;
const testNodeId = (f: { scope: string; rel: string }) => `test:${f.scope}/${f.rel}`;
const nodeIdForFile = (f: { scope: string; rel: string; isTest: boolean }) => (f.isTest ? testNodeId(f) : fileNodeId(f));

function compact<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

async function readText(abs: string, limit: number): Promise<string | undefined> {
  try {
    const info = await stat(abs);
    if (info.size > limit) return undefined;
    const text = await readFile(abs, "utf8");
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Extracts the code layer for every configured scope. */
export async function ingest(root: string, config: CodeConfig): Promise<IngestResult> {
  const warnings: string[] = [];
  const diag: Diagnostics = { warn: (m) => warnings.push(m) };
  const files = await discoverFiles(root, config);

  const parsed: ParsedFile[] = [];
  const plain: PlainFile[] = [];
  const i18nFiles: I18nFile[] = [];
  const tsconfigPaths: string[] = [];
  const packages = new PackageIndex();
  const nextDirsByScope = new Map<string, Set<string>>();

  await mapLimit(files, 32, async (f) => {
    if (f.role === "tsconfig") {
      tsconfigPaths.push(f.path);
      return;
    }
    const text = await readText(f.abs, f.role === "text" ? MAX_TEXT_BYTES : MAX_CODE_BYTES);
    if (text === undefined) {
      if (f.role === "code") diag.warn(`${f.path}: skipped (unreadable, binary or larger than ${MAX_CODE_BYTES} bytes)`);
      return;
    }
    switch (f.role) {
      case "manifest":
        packages.parse(basenamePosix(f.rel), f.path, f.scope, text, diag);
        return;
      case "i18n":
        i18nFiles.push({ file: f, hash: sha16(text), entries: parseI18nFile(f.rel, text, diag, f.path) });
        return;
      case "mdx":
      case "text": {
        const annotations = scanTextAnnotations(text);
        if (f.role === "mdx" || annotations.length > 0) plain.push({ file: f, hash: sha16(text), generated: isGeneratedText(text), annotations });
        return;
      }
      case "code": {
        if (isNextConfig(f.rel)) {
          let set = nextDirsByScope.get(f.scope);
          if (!set) nextDirsByScope.set(f.scope, (set = new Set()));
          set.add(dirnamePosix(f.rel));
        }
        const generated = isGeneratedText(text);
        try {
          if (f.lang === "ts") parsed.push(parseTypeScript(f, text, generated));
          else if (f.lang === "swift") parsed.push(parseSwift(f, text, generated));
          else if (f.lang === "kotlin") parsed.push(parseKotlin(f, text, generated));
          else if (f.lang === "go") parsed.push(parseGo(f, text, generated));
        } catch (err) {
          diag.warn(`${f.path}: parse failed (${(err as Error).message})`);
        }
        return;
      }
    }
  });
  packages.finalize();
  parsed.sort((a, b) => a.file.path.localeCompare(b.file.path));
  plain.sort((a, b) => a.file.path.localeCompare(b.file.path));
  i18nFiles.sort((a, b) => a.file.path.localeCompare(b.file.path));
  tsconfigPaths.sort();

  const builder = new GraphBuilder(root, diag, packages);
  builder.build(parsed, plain, i18nFiles, tsconfigPaths, nextDirsByScope);
  return { graph: builder.graph, warnings };
}

class GraphBuilder {
  readonly graph = new Graph();
  private readonly symbolById = new Map<string, SymbolDecl>();
  private readonly symbolFile = new Map<string, string>();
  private readonly screensBySymbol = new Map<string, string[]>();
  private readonly tsByPath = new Map<string, TsParsed>();
  private resolver!: TsResolver;
  private readonly nodeIdByPath = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly diag: Diagnostics,
    private readonly packages: PackageIndex,
  ) {}

  private edge(from: string, to: string, type: EdgeType, extra: Partial<GraphEdge> = {}): void {
    if (from === to) return;
    this.graph.addEdge(compact({ from, to, type, origin: "extracted" as const, ...extra }));
  }

  build(parsed: ParsedFile[], plain: PlainFile[], i18nFiles: I18nFile[], tsconfigPaths: string[], nextDirs: Map<string, Set<string>>): void {
    for (const p of parsed) this.nodeIdByPath.set(p.file.path, nodeIdForFile(p.file));
    for (const p of plain) this.nodeIdByPath.set(p.file.path, fileNodeId(p.file));
    for (const p of parsed) if (p.lang === "ts") this.tsByPath.set(p.file.path, p as TsParsed);

    const tsFiles = new Set<string>([...this.tsByPath.keys(), ...plain.filter((p) => p.file.lang === "mdx").map((p) => p.file.path)]);
    const configs: TsPathConfig[] = [];
    for (const path of tsconfigPaths) {
      const cfg = loadTsConfig(path, (rel) => {
        try {
          return readFileSync(resolve(this.root, rel), "utf8");
        } catch {
          return undefined;
        }
      });
      if (cfg) configs.push(cfg);
      else this.diag.warn(`${path}: could not read tsconfig`);
    }
    this.resolver = new TsResolver(tsFiles, configs);

    this.addFileNodes(parsed, plain, i18nFiles);
    this.addSymbols(parsed);
    this.addPackages();
    this.addI18n(parsed, i18nFiles);
    this.addSignals(parsed);
    this.addScreens(parsed);
    this.addAnnotations(parsed, plain);
    this.addRoutes(parsed, plain, nextDirs);
    this.addTsEdges(parsed);
    this.addClikeEdges(parsed);
    this.addMemberEdges();
  }

  // ---- nodes ---------------------------------------------------------------------------------

  private addFileNodes(parsed: ParsedFile[], plain: PlainFile[], i18nFiles: I18nFile[]): void {
    const add = (f: DiscoveredFile, hash: string, lang: string, generated: boolean) => {
      this.graph.addNode({
        id: nodeIdForFile(f),
        kind: f.isTest ? "test" : "file",
        label: basenamePosix(f.rel),
        location: { file: f.path, line: 1 },
        hash,
        meta: compact({ path: f.path, scope: f.scope, scopeDir: f.scopeDir, lang, generated: generated || undefined }),
      });
    };
    for (const p of parsed) add(p.file as DiscoveredFile, p.hash, p.file.lang, p.generated);
    for (const p of plain) add(p.file, p.hash, p.file.lang, p.generated);
    for (const i of i18nFiles) add(i.file, i.hash, "i18n", false);
  }

  private addSymbols(parsed: ParsedFile[]): void {
    for (const p of parsed) {
      if (p.file.isTest) continue;
      const fileId = fileNodeId(p.file);
      for (const s of p.symbols) {
        const existing = this.symbolById.get(s.id);
        if (existing) {
          // same id declared in another file (e.g. overloads spread over extensions): one node, combined hash
          existing.hash = sha16(existing.hash + s.hash);
          const node = this.graph.node(s.id)!;
          const also = [...((node.meta?.alsoIn as string[] | undefined) ?? []), p.file.path];
          this.graph.addNode({ ...node, hash: existing.hash, meta: { ...node.meta, alsoIn: also } });
          this.edge(fileId, s.id, "contains");
          continue;
        }
        this.symbolById.set(s.id, s);
        this.symbolFile.set(s.id, p.file.path);
        this.graph.addNode({
          id: s.id,
          kind: "symbol",
          label: s.name,
          location: { file: p.file.path, line: s.line, endLine: s.endLine },
          hash: s.hash,
          value: s.value,
          meta: compact({
            kind: s.kind,
            qname: s.qname,
            scope: p.file.scope,
            lang: p.file.lang,
            exported: s.exported,
            static: s.isStatic,
            generated: p.generated || undefined,
            parent: s.parent,
            ranges: s.ranges,
          }),
        });
        this.edge(fileId, s.id, "contains");
      }
    }
  }

  private addMemberEdges(): void {
    for (const s of this.symbolById.values()) {
      if (s.parent && this.graph.hasNode(s.parent) && this.graph.node(s.parent)?.kind === "symbol") {
        this.edge(s.parent, s.id, "references", { meta: { member: true } });
      }
    }
  }

  private addPackages(): void {
    for (const p of this.packages.packages.values()) {
      this.graph.addNode({
        id: p.id,
        kind: "package",
        label: p.name,
        hash: p.version !== undefined ? hashJson({ version: p.version }) : undefined,
        meta: compact({
          ecosystem: p.ecosystem,
          version: p.version,
          direct: p.direct || undefined,
          transitive: p.transitive,
          dev: p.dev,
          url: p.url,
          manifests: p.files,
          scope: p.scope,
        }),
      });
    }
  }

  private addI18n(parsed: ParsedFile[], i18nFiles: I18nFile[]): void {
    const byId = new Map<string, { scope: string; key: string; value: Record<string, string>; locations: { file: string; line: number; locale: string }[] }>();
    for (const f of i18nFiles) {
      for (const e of f.entries) {
        const id = `i18n:${f.file.scope}/${e.key}`;
        let entry = byId.get(id);
        if (!entry) byId.set(id, (entry = { scope: f.file.scope, key: e.key, value: {}, locations: [] }));
        entry.value[e.locale] = e.value;
        entry.locations.push({ file: f.file.path, line: e.line, locale: e.locale });
        this.edge(fileNodeId(f.file), id, "contains");
      }
    }
    for (const [id, e] of byId) {
      const value = Object.fromEntries(Object.entries(e.value).sort(([a], [b]) => a.localeCompare(b)));
      const first = e.locations[0]!;
      this.graph.addNode({
        id,
        kind: "i18n",
        label: e.key,
        value,
        hash: hashJson(value),
        location: { file: first.file, line: first.line },
        meta: { scope: e.scope, key: e.key, locations: e.locations },
      });
    }
    for (const p of parsed) {
      if (p.file.isTest) continue;
      const fileId = fileNodeId(p.file);
      for (const r of p.i18nRefs) {
        const id = `i18n:${p.file.scope}/${r.key}`;
        if (byId.has(id)) this.edge(r.from ?? fileId, id, "references");
      }
    }
  }

  private addSignals(parsed: ParsedFile[]): void {
    const edgeType = { env: "readsEnv", flag: "readsFlag", event: "emits" } as const;
    for (const p of parsed) {
      if (p.file.isTest) continue;
      const fileId = fileNodeId(p.file);
      for (const s of p.signals) {
        const id = `${s.kind}:${s.name}`;
        if (!this.graph.hasNode(id)) this.graph.addNode({ id, kind: s.kind, label: s.name });
        this.edge(s.from ?? fileId, id, edgeType[s.kind], { meta: { file: p.file.path, line: s.line } });
      }
    }
  }

  private addScreen(id: string, name: string, symbolId: string, origin: "extracted" | "annotation", scope: string): void {
    const target = this.graph.node(symbolId);
    this.graph.addNode(
      compact({
        id,
        kind: "screen" as const,
        label: name,
        hash: target?.hash,
        location: target?.location,
        meta: { scope },
      }),
    );
    this.edge(id, symbolId, "references", origin === "annotation" ? { origin, confidence: 1 } : {});
    pushMulti(this.screensBySymbol, symbolId, id);
  }

  private addScreens(parsed: ParsedFile[]): void {
    for (const p of parsed) {
      if (p.file.isTest) continue;
      for (const s of p.screens) this.addScreen(`screen:${p.file.scope}/${s.name}`, s.name, s.symbolId, "extracted", p.file.scope);
    }
  }

  private addRoutes(parsed: ParsedFile[], plain: PlainFile[], nextDirs: Map<string, Set<string>>): void {
    const isNextScope = (scope: string) =>
      nextDirs.has(scope) || [...this.packages.packages.values()].some((p) => p.id === "pkg:npm/next" && p.files.length > 0 && p.scope === scope);
    const dirsFor = (scope: string) => [...new Set(["", ...(nextDirs.get(scope) ?? [])])].sort((a, b) => b.length - a.length);
    const candidates: { file: DiscoveredFile; hash: string; ts?: TsParsed }[] = [
      ...parsed.filter((p) => p.lang === "ts").map((p) => ({ file: p.file as DiscoveredFile, hash: p.hash, ts: p as TsParsed })),
      ...plain.filter((p) => p.file.lang === "mdx").map((p) => ({ file: p.file, hash: p.hash })),
    ];
    for (const c of candidates) {
      if (!isNextScope(c.file.scope)) continue;
      const route = detectRoute(c.file, dirsFor(c.file.scope));
      if (!route) continue;
      this.graph.addNode({
        id: route.id,
        kind: "route",
        label: `/${route.url}`,
        hash: c.hash,
        location: { file: c.file.path, line: 1 },
        meta: compact({ scope: c.file.scope, url: `/${route.url}`, api: route.api || undefined, router: route.router, path: c.file.path }),
      });
      const served: string[] = [];
      if (c.ts) {
        const names = route.api && route.router === "app" ? ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] : ["default", "metadata", "generateMetadata"];
        for (const name of names) {
          const id = this.resolveExport(c.file.path, name, new Set());
          if (id) served.push(id);
        }
      }
      if (served.length === 0) served.push(fileNodeId(c.file));
      for (const id of served) this.edge(route.id, id, "serves");
    }
  }

  // ---- TypeScript ----------------------------------------------------------------------------

  /** Symbol id exported from `path` under `name`, following re-exports. */
  private resolveExport(path: string, name: string, visited: Set<string>): string | undefined {
    const key = `${path}\u0000${name}`;
    if (visited.has(key)) return undefined;
    visited.add(key);
    const mod = this.tsByPath.get(path);
    if (!mod) return undefined;
    const entry = mod.exports.get(name);
    if (entry) {
      if (entry.local !== undefined) {
        const local = mod.topLevel.get(entry.local);
        if (local) return local;
        return this.resolveBinding(mod, entry.local, visited);
      }
      if (entry.from !== undefined && entry.imported !== undefined && entry.imported !== "*") {
        const target = this.resolver.resolve(path, entry.from);
        return target ? this.resolveExport(target, entry.imported, visited) : undefined;
      }
      return undefined;
    }
    if (name === "default") return undefined;
    for (const spec of mod.starExports) {
      const target = this.resolver.resolve(path, spec);
      const hit = target ? this.resolveExport(target, name, visited) : undefined;
      if (hit) return hit;
    }
    return undefined;
  }

  /** Symbol id an imported local binding refers to. */
  private resolveBinding(mod: TsParsed, local: string, visited: Set<string>, member?: string): string | undefined {
    for (const imp of mod.imports) {
      const b = imp.bindings.find((x) => x.local === local);
      if (!b) continue;
      const target = this.resolver.resolve(mod.file.path, imp.spec);
      if (!target) return undefined;
      if (b.imported === "*") return member ? this.resolveExport(target, member, visited) : undefined;
      const id = this.resolveExport(target, b.imported, visited);
      if (id && member) return this.memberOf(id, member) ?? id;
      return id;
    }
    return undefined;
  }

  private memberOf(symbolId: string, member: string): string | undefined {
    const file = this.symbolFile.get(symbolId);
    const mod = file ? this.tsByPath.get(file) : undefined;
    return mod?.members.get(symbolId)?.get(member);
  }

  private isAncestor(candidate: string, of: string): boolean {
    let cur = this.symbolById.get(of)?.parent;
    for (let n = 0; cur && n < 32; n++) {
      if (cur === candidate) return true;
      cur = this.symbolById.get(cur)?.parent;
    }
    return false;
  }

  private addTsEdges(parsed: ParsedFile[]): void {
    for (const p of parsed) {
      if (p.lang !== "ts") continue;
      const mod = p as TsParsed;
      const fromNode = nodeIdForFile(p.file);
      for (const imp of mod.imports) {
        const target = this.resolver.resolve(p.file.path, imp.spec);
        if (target) {
          const targetId = this.nodeIdByPath.get(target);
          if (targetId) this.edge(fromNode, targetId, "imports");
          if (p.file.isTest) {
            let any = false;
            for (const b of imp.bindings) {
              const id = b.imported === "*" ? undefined : this.resolveExport(target, b.imported, new Set());
              if (id) {
                this.addTestEdge(fromNode, id);
                any = true;
              }
            }
            if (!any && targetId) this.edge(fromNode, targetId, "tests");
          }
          continue;
        }
        const name = npmPackageName(imp.spec);
        if (!name) continue;
        const pkgId = `pkg:npm/${name}`;
        if (!this.graph.hasNode(pkgId)) {
          this.graph.addNode({ id: pkgId, kind: "package", label: name, meta: { ecosystem: "npm", declared: false, scope: p.file.scope } });
        }
        this.edge(fromNode, pkgId, "dependsOn");
      }
      if (p.file.isTest) continue;
      for (const r of mod.localRefs) {
        let target: string | undefined;
        const local = mod.topLevel.get(r.name);
        if (local) target = (r.member ? mod.members.get(local)?.get(r.member) : undefined) ?? local;
        else target = this.resolveBinding(mod, r.name, new Set(), r.member);
        if (!target || target === r.from || this.isAncestor(target, r.from)) continue;
        this.edge(r.from, target, "references");
      }
    }
  }

  private addTestEdge(testId: string, symbolId: string, confidence?: number): void {
    this.edge(testId, symbolId, "tests", confidence !== undefined ? { confidence } : {});
    for (const screen of this.screensBySymbol.get(symbolId) ?? []) this.edge(testId, screen, "tests", confidence !== undefined ? { confidence } : {});
  }

  // ---- Swift / Kotlin / Go ---------------------------------------------------------------------

  private addClikeEdges(parsed: ParsedFile[]): void {
    const groups = new Map<string, ClikeParsed[]>();
    for (const p of parsed) {
      if (p.lang === "ts") continue;
      const c = p as ClikeParsed;
      pushMulti(groups, `${c.file.scope}\u0000${c.lang}`, c);
    }
    for (const list of groups.values()) {
      const lang = list[0]!.lang;
      if (lang === "go") this.linkGo(list);
      else this.linkSwiftKotlin(list);
      for (const c of list) this.linkClikePackages(c);
    }
  }

  private linkClikePackages(c: ClikeParsed): void {
    const from = nodeIdForFile(c.file);
    for (const imp of c.imports) {
      let ids: string[] = [];
      if (c.lang === "swift") ids = this.packages.matchSwiftModule(imp, c.file.scope);
      else if (c.lang === "kotlin") ids = this.packages.matchKotlinImport(imp);
      else {
        const id = this.packages.matchGoImport(imp);
        if (id) ids = [id];
      }
      for (const id of ids) this.edge(from, id, "dependsOn");
    }
  }

  private linkSwiftKotlin(list: ClikeParsed[]): void {
    const types = new Map<string, string>();
    const simpleTypes = new Map<string, string[]>();
    const members = new Map<string, Map<string, string>>();
    const memberByName = new Map<string, { id: string; isStatic: boolean }[]>();
    const topLevel = new Map<string, string[]>();
    for (const c of list) {
      if (c.file.isTest) continue;
      for (const s of c.symbols) {
        if (s.isType) {
          types.set(s.qname, s.id);
          if (!s.qname.includes(".")) pushMulti(simpleTypes, s.qname, s.id);
        }
        const dot = s.qname.lastIndexOf(".");
        if (dot > 0) {
          const owner = s.qname.slice(0, dot);
          let m = members.get(owner);
          if (!m) members.set(owner, (m = new Map()));
          m.set(s.name, s.id);
          if (!s.isType) pushMulti(memberByName, s.name, { id: s.id, isStatic: !!s.isStatic });
        } else if (!s.isType) pushMulti(topLevel, s.qname, s.id);
      }
    }
    const parentQ = (q: string) => (q.includes(".") ? q.slice(0, q.lastIndexOf(".")) : undefined);
    const resolveType = (name: string, owner?: string): string | undefined => {
      for (let o = owner; o; o = parentQ(o)) if (types.has(`${o}.${name}`)) return `${o}.${name}`;
      if (types.has(name)) return name;
      return undefined;
    };
    const resolve = (r: NameRef): { ids: string[]; confidence: number } => {
      const [head, ...rest] = r.chain;
      if (!head) return { ids: [], confidence: 0 };
      if (r.leadingDot) {
        const hits = (memberByName.get(head) ?? []).filter((m) => m.isStatic);
        return hits.length === 1 ? { ids: [hits[0]!.id], confidence: 0.6 } : { ids: [], confidence: 0 };
      }
      if (head === "self" || head === "this") {
        const name = rest[0];
        for (let o = r.owner; o && name; o = parentQ(o)) {
          const hit = members.get(o)?.get(name);
          if (hit) return { ids: [hit], confidence: 0.8 };
        }
        return { ids: [], confidence: 0 };
      }
      let tq = resolveType(head, r.owner);
      if (tq) {
        for (const part of rest) {
          if (types.has(`${tq}.${part}`)) {
            tq = `${tq}.${part}`;
            continue;
          }
          const m = members.get(tq)?.get(part);
          if (m) return { ids: [m], confidence: 0.8 };
          break;
        }
        return { ids: [types.get(tq)!], confidence: 0.8 };
      }
      for (let o = r.owner; o; o = parentQ(o)) {
        const hit = members.get(o)?.get(head);
        if (hit) return { ids: [hit], confidence: 0.8 };
      }
      const top = topLevel.get(head);
      if (top) return { ids: top, confidence: 0.8 };
      return { ids: [], confidence: 0 };
    };
    for (const c of list) {
      const testId = c.file.isTest ? testNodeId(c.file) : undefined;
      for (const r of c.refs) {
        const { ids, confidence } = resolve(r);
        for (const id of ids) {
          if (testId) this.addTestEdge(testId, id, confidence);
          else if (r.from && id !== r.from && !this.isAncestor(id, r.from)) this.edge(r.from, id, "references", { confidence });
        }
      }
    }
  }

  private linkGo(list: ClikeParsed[]): void {
    const byNamespace = new Map<string, Map<string, string>>();
    const namespaceByDir = new Map<string, string>();
    for (const c of list) {
      if (!c.go) continue;
      namespaceByDir.set(c.go.dir, c.go.namespace);
      if (c.file.isTest) continue;
      let m = byNamespace.get(c.go.namespace);
      if (!m) byNamespace.set(c.go.namespace, (m = new Map()));
      for (const s of c.symbols) m.set(s.qname.slice(c.go.namespace.length + 1), s.id);
    }
    for (const c of list) {
      if (!c.go) continue;
      const own = byNamespace.get(c.go.namespace);
      const testId = c.file.isTest ? testNodeId(c.file) : undefined;
      for (const r of c.refs) {
        const [head, next] = r.chain;
        if (!head) continue;
        let target: string | undefined;
        const importPath = c.go.aliases[head];
        if (importPath && next) {
          const dir = this.packages.goInternalDir(importPath);
          const ns = dir !== undefined ? namespaceByDir.get(dir) : undefined;
          target = ns ? byNamespace.get(ns)?.get(next) : undefined;
        } else if (own) {
          target = (next ? own.get(`${head}.${next}`) : undefined) ?? own.get(head);
        }
        if (!target) continue;
        if (testId) this.addTestEdge(testId, target, 0.9);
        else if (r.from && target !== r.from && !this.isAncestor(target, r.from)) this.edge(r.from, target, "references", { confidence: 0.9 });
      }
    }
  }

  // ---- annotations ---------------------------------------------------------------------------

  private addAnnotations(parsed: ParsedFile[], plain: PlainFile[]): void {
    const sources: { file: DiscoveredFile; annotations: AnnotationComment[]; symbols: SymbolDecl[]; codeLines: Set<number> }[] = [
      ...parsed.map((p) => ({ file: p.file as DiscoveredFile, annotations: p.annotations, symbols: p.file.isTest ? [] : p.symbols, codeLines: p.codeLines })),
      ...plain.map((p) => ({ file: p.file, annotations: p.annotations, symbols: [], codeLines: new Set<number>() })),
    ];
    for (const src of sources) {
      const fileId = nodeIdForFile(src.file);
      for (const comment of src.annotations) {
        const target = annotationTarget(comment, src.symbols, src.codeLines, fileId);
        for (const entry of parseAnnotations(comment)) {
          const where = `${src.file.path}:${entry.line}`;
          if (MARKER_VERBS.has(entry.verb)) continue;
          if (entry.verb === "screen") {
            const name = entry.targets[0];
            if (!name) {
              this.diag.warn(`${where}: @starchart screen needs a name`);
              continue;
            }
            const id = name.startsWith("screen:") ? name : `screen:${src.file.scope}/${name}`;
            this.addScreen(id, id.slice(id.lastIndexOf("/") + 1), target, "annotation", src.file.scope);
            continue;
          }
          if (!isEdgeType(entry.verb)) {
            this.diag.warn(`${where}: unknown @starchart edge type "${entry.verb}"`);
            continue;
          }
          if (entry.targets.length === 0) {
            this.diag.warn(`${where}: @starchart ${entry.verb} has no target node ids`);
            continue;
          }
          for (const to of entry.targets) {
            this.edge(target, to, entry.verb, { origin: "annotation", confidence: 1, meta: { file: src.file.path, line: entry.line } });
          }
        }
      }
    }
  }
}
