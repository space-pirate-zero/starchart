import ts from "typescript";
import { dirnamePosix, joinPosix } from "./util.js";

/** Path mapping from one tsconfig/jsconfig, with every path made root-relative. */
export interface TsPathConfig {
  /** Root-relative directory of the config file. */
  dir: string;
  baseUrl?: string;
  paths: [string, string[]][];
}

const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".mdx"];
const JS_EXT = /\.(?:js|jsx|mjs|cjs)$/;

interface RawOptions {
  baseUrl?: string;
  paths?: Record<string, string[]>;
  /** Directory the option values are relative to. */
  baseDir: string;
  pathsDir: string;
}

/**
 * Reads a tsconfig/jsconfig (JSON with comments), following relative `extends` chains.
 * `readFile` takes a root-relative path and returns its text, or undefined.
 */
export function loadTsConfig(path: string, readFile: (rootRelative: string) => string | undefined, depth = 0): TsPathConfig | undefined {
  const raw = readRaw(path, readFile, depth);
  if (!raw) return undefined;
  const dir = dirnamePosix(path);
  const baseUrl = raw.baseUrl !== undefined ? joinPosix(raw.baseDir, raw.baseUrl) : undefined;
  const pathsBase = baseUrl ?? raw.pathsDir;
  const paths: [string, string[]][] = Object.entries(raw.paths ?? {}).map(([pattern, targets]) => [
    pattern,
    (Array.isArray(targets) ? targets : []).filter((t): t is string => typeof t === "string").map((t) => joinPosix(pathsBase, t)),
  ]);
  return { dir, baseUrl, paths };
}

function readRaw(path: string, readFile: (p: string) => string | undefined, depth: number): RawOptions | undefined {
  if (depth > 8) return undefined;
  const text = readFile(path);
  if (text === undefined) return undefined;
  const parsed = ts.parseConfigFileTextToJson(path, text);
  if (parsed.error || !parsed.config || typeof parsed.config !== "object") return undefined;
  const config = parsed.config as { extends?: string | string[]; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  const dir = dirnamePosix(path);
  let merged: RawOptions = { baseDir: dir, pathsDir: dir };
  const parents = config.extends === undefined ? [] : Array.isArray(config.extends) ? config.extends : [config.extends];
  for (const ext of parents) {
    if (typeof ext !== "string" || !ext.startsWith(".")) continue;
    let target = joinPosix(dir, ext);
    if (!target.endsWith(".json")) target += ".json";
    const parent = readRaw(target, readFile, depth + 1);
    if (parent) merged = { ...merged, ...parent };
  }
  const opts = config.compilerOptions ?? {};
  if (typeof opts.baseUrl === "string") merged = { ...merged, baseUrl: opts.baseUrl, baseDir: dir };
  if (opts.paths && typeof opts.paths === "object") merged = { ...merged, paths: opts.paths, pathsDir: dir };
  return merged;
}

/** Resolves relative and path-mapped module specifiers to known root-relative source files. */
export class TsResolver {
  private readonly byDir = new Map<string, TsPathConfig>();

  constructor(
    private readonly files: ReadonlySet<string>,
    configs: TsPathConfig[],
  ) {
    for (const c of configs) this.byDir.set(c.dir, c);
  }

  private configFor(fromPath: string): TsPathConfig | undefined {
    let dir = dirnamePosix(fromPath);
    for (;;) {
      const c = this.byDir.get(dir);
      if (c) return c;
      if (dir === "") return undefined;
      dir = dirnamePosix(dir);
    }
  }

  /** Root-relative file an import resolves to, or undefined for packages and unknown files. */
  resolve(fromPath: string, spec: string): string | undefined {
    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
      return this.tryFile(joinPosix(dirnamePosix(fromPath), spec));
    }
    if (spec.startsWith("/")) return undefined;
    const config = this.configFor(fromPath);
    if (!config) return undefined;
    for (const [pattern, targets] of config.paths) {
      const star = pattern.indexOf("*");
      let capture: string | undefined;
      if (star < 0) {
        if (spec === pattern) capture = "";
      } else {
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length) {
          capture = spec.slice(prefix.length, spec.length - suffix.length);
        }
      }
      if (capture === undefined) continue;
      for (const target of targets) {
        const hit = this.tryFile(target.replace("*", capture));
        if (hit) return hit;
      }
    }
    if (config.baseUrl !== undefined) return this.tryFile(joinPosix(config.baseUrl, spec));
    return undefined;
  }

  private tryFile(p: string): string | undefined {
    if (this.files.has(p)) return p;
    if (JS_EXT.test(p)) {
      const stem = p.replace(JS_EXT, "");
      for (const ext of EXTS) if (this.files.has(stem + ext)) return stem + ext;
    }
    for (const ext of EXTS) if (this.files.has(p + ext)) return p + ext;
    for (const ext of EXTS) {
      const idx = joinPosix(p, `index${ext}`);
      if (this.files.has(idx)) return idx;
    }
    return undefined;
  }
}
