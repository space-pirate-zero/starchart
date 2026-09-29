import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Graph } from "./core/graph.js";

/**
 * W3C Design Tokens (DTCG) import: tokens become facts under the `tokens` entity so a
 * rebrand (`color.brand.primary`) has a blast radius like any other fact.
 */

export const TOKENS_ENTITY = "tokens";

export interface FlatToken {
  /** Dot path, e.g. "color.brand.primary". */
  path: string;
  /** Resolved value (aliases replaced by their targets' values). */
  value: unknown;
  /** Raw `$value` as authored. */
  raw: unknown;
  /** `$type`, inherited from the nearest group that declares one. */
  type?: string;
  description?: string;
  /** Path of the token this one aliases when `$value` is exactly `{path}`. */
  aliasOf?: string;
  /** Source file, when read from disk. */
  file?: string;
}

interface RawToken {
  path: string;
  raw: unknown;
  type?: string;
  description?: string;
  file?: string;
}

export interface TokenGroupInfo {
  path: string;
  type?: string;
  description?: string;
}

const ALIAS_EXACT = /^\{([^{}]+)\}$/;
const ALIAS_ANY = /\{([^{}]+)\}/g;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Walks a DTCG document collecting raw tokens and groups (no alias resolution). */
function collect(
  json: unknown,
  file: string | undefined,
  tokens: RawToken[],
  groups: TokenGroupInfo[],
  prefix = "",
  inheritedType?: string,
): void {
  if (!isObject(json)) throw new Error(`${file ?? "tokens"}: expected a JSON object${prefix ? ` at "${prefix}"` : ""}`);
  const groupType = typeof json.$type === "string" ? json.$type : inheritedType;
  for (const [key, child] of Object.entries(json)) {
    if (key.startsWith("$")) continue;
    if (/[.{}]/.test(key)) throw new Error(`${file ?? "tokens"}: invalid token name "${key}" (may not contain ".", "{" or "}")`);
    const path = prefix ? `${prefix}.${key}` : key;
    if (!isObject(child)) throw new Error(`${file ?? "tokens"}: "${path}" must be a group or a token object with $value`);
    if ("$value" in child) {
      tokens.push({
        path,
        raw: child.$value,
        type: typeof child.$type === "string" ? child.$type : groupType,
        description: typeof child.$description === "string" ? child.$description : undefined,
        file,
      });
    } else {
      groups.push({
        path,
        type: typeof child.$type === "string" ? child.$type : undefined,
        description: typeof child.$description === "string" ? child.$description : undefined,
      });
      collect(child, file, tokens, groups, path, groupType);
    }
  }
}

/** Resolves `{path}` aliases (whole-value, embedded in strings, and nested in composite values). */
function resolveAll(raw: RawToken[]): FlatToken[] {
  const byPath = new Map(raw.map((t) => [t.path, t]));
  const resolved = new Map<string, unknown>();
  const resolving = new Set<string>();

  const resolveToken = (path: string, from: string): unknown => {
    if (resolved.has(path)) return resolved.get(path);
    const token = byPath.get(path);
    if (!token) throw new Error(`token "${from}" references unknown token "{${path}}"`);
    if (resolving.has(path)) throw new Error(`circular token alias: ${[...resolving, path].join(" → ")}`);
    resolving.add(path);
    const value = resolveValue(token.raw, path);
    resolving.delete(path);
    resolved.set(path, value);
    return value;
  };

  const resolveValue = (value: unknown, from: string): unknown => {
    if (typeof value === "string") {
      const exact = ALIAS_EXACT.exec(value);
      if (exact) return resolveToken(exact[1]!, from);
      if (!value.includes("{")) return value;
      return value.replace(ALIAS_ANY, (_, path: string) => {
        const v = resolveToken(path, from);
        return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
      });
    }
    if (Array.isArray(value)) return value.map((v) => resolveValue(v, from));
    if (isObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, from);
      return out;
    }
    return value;
  };

  return raw.map((t) => {
    const flat: FlatToken = { path: t.path, value: resolveToken(t.path, t.path), raw: t.raw };
    if (t.type) flat.type = t.type;
    if (t.description) flat.description = t.description;
    if (t.file) flat.file = t.file;
    if (typeof t.raw === "string") {
      const exact = ALIAS_EXACT.exec(t.raw);
      if (exact) flat.aliasOf = exact[1]!;
    }
    return flat;
  });
}

/** Flattens one DTCG document into resolved tokens, in document order. */
export function flattenTokens(json: unknown): FlatToken[] {
  const tokens: RawToken[] = [];
  collect(json, undefined, tokens, []);
  return resolveAll(tokens);
}

/**
 * Reads DTCG JSON files (relative to `root`) and adds them to the graph: the `tokens` entity
 * (`sc:DesignTokens`), one container fact per group and one leaf fact per token, linked with
 * `partOf` exactly like compiled YAML facts. Aliases are resolved across all files and recorded
 * as `meta.aliasOf` (the target fact id).
 */
export function importTokens(graph: Graph, root: string, files: string[]): { count: number } {
  const raw: RawToken[] = [];
  const groups: TokenGroupInfo[] = [];
  for (const file of files) {
    const path = resolve(root, file);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`${file}: cannot read design tokens: ${(error as Error).message}`);
    }
    collect(json, file, raw, groups);
  }
  const seen = new Set<string>();
  for (const t of raw) {
    if (seen.has(t.path)) throw new Error(`${t.file ?? "tokens"}: duplicate token "${t.path}"`);
    seen.add(t.path);
  }
  const tokens = resolveAll(raw);
  if (tokens.length === 0) return { count: 0 };

  graph.addNode({
    id: TOKENS_ENTITY,
    kind: "entity",
    label: "Design tokens",
    types: ["sc:DesignTokens"],
    meta: { files: [...files] },
  });

  const factId = (path: string) => `${TOKENS_ENTITY}.${path}`;
  const groupInfo = new Map(groups.map((g) => [g.path, g]));
  const containers = new Map<string, Record<string, unknown>>();
  const ensureParents = (path: string) => {
    const parts = path.split(".");
    for (let i = 1; i < parts.length; i++) {
      const groupPath = parts.slice(0, i).join(".");
      if (containers.has(groupPath)) continue;
      containers.set(groupPath, {});
      const info = groupInfo.get(groupPath);
      const meta: Record<string, unknown> = { entity: TOKENS_ENTITY, tokenGroup: true };
      if (info?.type) meta.tokenType = info.type;
      if (info?.description) meta.description = info.description;
      graph.addNode({ id: factId(groupPath), kind: "fact", meta });
      const parent = i === 1 ? TOKENS_ENTITY : factId(parts.slice(0, i - 1).join("."));
      graph.addEdge({ from: factId(groupPath), to: parent, type: "partOf", origin: "declared" });
    }
  };

  for (const token of tokens) {
    ensureParents(token.path);
    const meta: Record<string, unknown> = { entity: TOKENS_ENTITY };
    if (token.file) meta.file = token.file;
    if (token.type) meta.tokenType = token.type;
    if (token.description) meta.description = token.description;
    if (token.aliasOf) meta.aliasOf = factId(token.aliasOf);
    graph.addNode({
      id: factId(token.path),
      kind: "fact",
      value: token.value,
      authority: "graph",
      source: token.file ? { file: token.file } : undefined,
      meta,
    });
    const parts = token.path.split(".");
    const parent = parts.length === 1 ? TOKENS_ENTITY : factId(parts.slice(0, -1).join("."));
    graph.addEdge({ from: factId(token.path), to: parent, type: "partOf", origin: "declared" });
  }

  // container values mirror the nested token tree
  const assemble = (prefix: string): Record<string, unknown> => {
    const value: Record<string, unknown> = {};
    const depth = prefix.split(".").length;
    for (const token of tokens) {
      if (!token.path.startsWith(`${prefix}.`)) continue;
      const key = token.path.split(".")[depth]!;
      if (key in value) continue;
      const childPath = `${prefix}.${key}`;
      value[key] = containers.has(childPath) ? assemble(childPath) : token.value;
    }
    return value;
  };
  for (const groupPath of containers.keys()) {
    const node = graph.node(factId(groupPath))!;
    graph.addNode({ ...node, value: assemble(groupPath) });
  }
  return { count: tokens.length };
}
