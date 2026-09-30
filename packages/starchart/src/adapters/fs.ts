import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { GraphNode } from "../core/model.js";
import { resolveInRoot } from "../paths.js";
import { unsafeRegexReason } from "../regex-safety.js";
import { renderOgBuffer } from "../render/og.js";
import { escapeFor, renderTemplate } from "../render/template.js";
import {
  applyReplacements,
  auditText,
  findValue,
  leafFacts,
  lineOf,
  planReplacements,
  type ReplacementPlan,
  type Span,
} from "./text.js";
import type { Adapter, AdapterContext, ApplyResult, Diff, UndoRecord } from "./types.js";

/**
 * Local files: source, content, generated assets.
 *
 * binding: { adapter: fs, path: "web/pricing.mdx", selector?: "json:$.plans.pro.price" | "regex:<pattern>" }
 *
 * Embedded facts are found and replaced as whole tokens. Artifacts with a template (`renders:
 * { template, with, out }`) are regenerated from it; an .svg template targeting a .png is rasterized.
 */

export interface FsUpdate {
  /** Root-relative target path. */
  path: string;
  kind: "text" | "svg" | "png";
  /** Current content, or null when the file does not exist yet. */
  before: Buffer | null;
  after: Buffer;
  changes: string[];
  error?: string;
}

const EDGES = ["embeds", "mirrors", "renders"] as const;

function bindingPath(node: GraphNode): string {
  const path = node.binding?.path;
  if (typeof path === "string" && path) return path;
  const out = node.meta?.templateOut;
  if (typeof out === "string" && out) return out;
  throw new Error(`${node.id}: fs binding needs a "path"`);
}

/** Resolves a root-relative path, refusing anything that escapes the project root. */
export { resolveInRoot };

const templateOf = (node: GraphNode): string | undefined =>
  typeof node.meta?.template === "string" ? node.meta.template : undefined;

const kindOf = (path: string): FsUpdate["kind"] => (/\.png$/i.test(path) ? "png" : /\.svg$/i.test(path) ? "svg" : "text");

// ---------------------------------------------------------------- selectors

type Selector = { type: "none" } | { type: "regex"; pattern: RegExp } | { type: "json"; path: (string | number)[]; raw: string };

export function parseSelector(selector: unknown): Selector {
  if (selector === undefined || selector === null || selector === "") return { type: "none" };
  if (typeof selector !== "string") throw new Error("fs selector must be a string");
  if (selector.startsWith("regex:")) {
    const unsafe = unsafeRegexReason(selector.slice("regex:".length));
    if (unsafe) throw new Error(`unsafe regex selector: ${unsafe}`);
    try {
      return { type: "regex", pattern: new RegExp(selector.slice("regex:".length), "gmd") };
    } catch (e) {
      throw new Error(`invalid regex selector: ${(e as Error).message}`);
    }
  }
  if (selector.startsWith("json:")) {
    const raw = selector.slice("json:".length).trim();
    return { type: "json", path: parseJsonPath(raw), raw };
  }
  throw new Error(`unknown selector "${selector}" (use "json:$.a.b" or "regex:<pattern>")`);
}

/** "$.plans[0].price" → ["plans", 0, "price"]. */
export function parseJsonPath(raw: string): (string | number)[] {
  let rest = raw.startsWith("$") ? raw.slice(1) : raw.startsWith(".") ? raw : `.${raw}`;
  const out: (string | number)[] = [];
  const token = /^(?:\.([^.[\]]+)|\[(\d+)\]|\[["']([^"']+)["']\])/;
  while (rest.length > 0) {
    const m = token.exec(rest);
    if (!m) throw new Error(`invalid JSON path "${raw}"`);
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(Number(m[2]));
    else if (m[3] !== undefined) out.push(m[3]);
    rest = rest.slice(m[0].length);
  }
  return out;
}

function regexRegions(text: string, pattern: RegExp): Span[] {
  const regions: Span[] = [];
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const group = m.indices?.[1];
    regions.push(group ? { start: group[0], end: group[1] } : { start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) pattern.lastIndex++;
  }
  return regions;
}

function getAt(doc: unknown, path: (string | number)[]): unknown {
  let cur = doc;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

function setAt(doc: unknown, path: (string | number)[], value: unknown): unknown {
  if (path.length === 0) return value;
  const parent = getAt(doc, path.slice(0, -1));
  if (parent === null || typeof parent !== "object") throw new Error("JSON selector target has no parent object");
  (parent as Record<string | number, unknown>)[path[path.length - 1]!] = value;
  return doc;
}

/** Applies `fn` to every scalar (string/number) inside `value`. */
function mapScalars(value: unknown, fn: (s: string | number) => string | number): unknown {
  if (typeof value === "string" || typeof value === "number") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapScalars(v, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapScalars(v, fn)]));
  }
  return value;
}

function scalarText(value: unknown): string {
  const parts: string[] = [];
  mapScalars(value, (s) => {
    parts.push(String(s));
    return s;
  });
  return parts.join("\n");
}

const detectIndent = (text: string): string | number => /\n([ \t]+)["\]}]/.exec(text)?.[1] ?? 2;

// ---------------------------------------------------------------- audit

async function auditEmbedded(node: GraphNode, ctx: AdapterContext): Promise<Diff[]> {
  const path = bindingPath(node);
  const abs = resolveInRoot(ctx.root, path);
  if (!existsSync(abs)) {
    return [{ artifact: node.id, kind: "missing", message: `file not found: ${path}`, where: path }];
  }
  const text = await readFile(abs, "utf8");
  const facts = leafFacts(ctx.graph, node.id, [...EDGES]);
  const selector = parseSelector(node.binding?.selector);
  if (selector.type === "json") {
    const target = getAt(parseJson(text, path), selector.path);
    if (target === undefined) {
      return [{ artifact: node.id, kind: "missing", message: `JSON path ${selector.raw} not found`, where: `${path} ${selector.raw}` }];
    }
    return auditText({
      artifact: node.id,
      text: scalarText(target),
      facts,
      previous: ctx.previousValues,
      where: () => `${path} ${selector.raw}`,
    });
  }
  return auditText({
    artifact: node.id,
    text,
    facts,
    previous: ctx.previousValues,
    regions: selector.type === "regex" ? regexRegions(text, selector.pattern) : undefined,
    where: (i) => `${path}:${lineOf(text, i)}`,
    whereMissing: path,
  });
}

async function auditTemplate(node: GraphNode, ctx: AdapterContext): Promise<Diff[]> {
  const update = await computeFsUpdate(node, ctx);
  if (update.error) return [{ artifact: node.id, kind: "break", message: update.error, where: update.path }];
  if (!update.before) {
    return [{ artifact: node.id, kind: "missing", message: `rendered output not found: ${update.path}`, where: update.path }];
  }
  const differs = update.kind === "png" ? pngDiffers(update.before, update.after) : !update.before.equals(update.after);
  return differs
    ? [{ artifact: node.id, kind: "mismatch", message: `out of date with template ${templateOf(node)}`, where: update.path }]
    : [];
}

/** Pixel comparison; undecodable or differently sized images count as different. */
function pngDiffers(a: Buffer, b: Buffer): boolean {
  if (a.equals(b)) return false;
  try {
    const pa = PNG.sync.read(a);
    const pb = PNG.sync.read(b);
    if (pa.width !== pb.width || pa.height !== pb.height) return true;
    return pixelmatch(pa.data, pb.data, undefined, pa.width, pa.height, { threshold: 0.1 }) > 0;
  } catch {
    return true;
  }
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`${path}: invalid JSON (${(e as Error).message})`);
  }
}

// ---------------------------------------------------------------- update

function describePlan(plan: ReplacementPlan, byFact: Record<string, number>): string[] {
  return plan.replacements
    .filter((r) => (byFact[r.fact] ?? 0) > 0)
    .map((r) => `${r.fact}: ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`)
    .filter((line, i, all) => all.indexOf(line) === i);
}

/**
 * The content an fs artifact should have for the current facts, without writing anything.
 * Shared by apply, audit (templates) and the Future Universe preview.
 */
export async function computeFsUpdate(node: GraphNode, ctx: AdapterContext): Promise<FsUpdate> {
  const path = bindingPath(node);
  const abs = resolveInRoot(ctx.root, path);
  const kind = kindOf(path);
  const before = existsSync(abs) ? await readFile(abs) : null;
  const template = templateOf(node);

  if (template) {
    const templateAbs = resolveInRoot(ctx.root, template);
    if (!existsSync(templateAbs)) return { path, kind, before, after: before ?? Buffer.alloc(0), changes: [], error: `template not found: ${template}` };
    try {
      let after: Buffer;
      if (kind === "png") {
        if (!/\.svg$/i.test(template)) throw new Error(`cannot render ${template} to PNG: only .svg templates rasterize`);
        after = await renderOgBuffer(templateAbs, ctx.graph, "png");
      } else {
        const source = await readFile(templateAbs, "utf8");
        after = Buffer.from(renderTemplate(source, ctx.graph, {}, { escape: escapeFor(path), name: template }), "utf8");
      }
      const changed = !before || !before.equals(after);
      return { path, kind, before, after, changes: changed ? [`render ${template} → ${path}`] : [] };
    } catch (e) {
      return { path, kind, before, after: before ?? Buffer.alloc(0), changes: [], error: (e as Error).message };
    }
  }

  if (!before) return { path, kind, before, after: Buffer.alloc(0), changes: [], error: `file not found: ${path}` };
  const text = before.toString("utf8");
  const facts = leafFacts(ctx.graph, node.id, [...EDGES]);
  const plan = planReplacements(facts, ctx.previousValues);
  const fail = (error: string): FsUpdate => ({ path, kind, before, after: before, changes: [], error });

  if (plan.ambiguous.length > 0) {
    const a = plan.ambiguous[0]!;
    return fail(
      `ambiguous: old value ${JSON.stringify(a.value)} of ${a.fact} is also the current value of ${a.conflictsWith}; add a selector to the binding`,
    );
  }
  if (plan.unplaced.length > 0) {
    return fail(
      `cannot place new item(s) ${plan.unplaced.map((u) => `${JSON.stringify(u.value)} (${u.fact})`).join(", ")} by find-and-replace; edit ${path} manually, then "starchart ack ${node.id}"`,
    );
  }
  if (plan.replacements.length === 0) return { path, kind, before, after: before, changes: [] };

  let selector: Selector;
  try {
    selector = parseSelector(node.binding?.selector);
  } catch (e) {
    return fail((e as Error).message);
  }

  let afterText: string;
  let byFact: Record<string, number>;
  let scope: string;
  if (selector.type === "json") {
    let doc: unknown;
    try {
      doc = parseJson(text, path);
    } catch (e) {
      return fail((e as Error).message);
    }
    const target = getAt(doc, selector.path);
    if (target === undefined) return fail(`JSON path ${selector.raw} not found in ${path}`);
    byFact = {};
    const updated = mapScalars(target, (s) => {
      const r = applyReplacements(String(s), plan.replacements);
      for (const [f, n] of Object.entries(r.byFact)) byFact[f] = (byFact[f] ?? 0) + n;
      if (typeof s === "number" && r.count > 0 && Number.isFinite(Number(r.text))) return Number(r.text);
      return r.count > 0 ? r.text : s;
    });
    const serialized = JSON.stringify(setAt(doc, selector.path, updated), null, detectIndent(text));
    afterText = text.endsWith("\n") ? `${serialized}\n` : serialized;
    scope = scalarText(updated);
  } else {
    const regions = selector.type === "regex" ? regexRegions(text, selector.pattern) : undefined;
    const r = applyReplacements(text, plan.replacements, regions);
    afterText = r.text;
    byFact = r.byFact;
    scope = afterText;
  }

  // Every changed fact must now be present; otherwise the old text was never found.
  const unresolved = plan.replacements.filter((r) => (byFact[r.fact] ?? 0) === 0 && !findValue(scope, r.to));
  if (unresolved.length > 0) {
    const r = unresolved[0]!;
    return fail(`could not find old value ${JSON.stringify(r.from)} of ${r.fact} in ${path}${selector.type !== "none" ? " (within selector)" : ""}`);
  }
  const after = Buffer.from(afterText, "utf8");
  return { path, kind, before, after, changes: after.equals(before) ? [] : describePlan(plan, byFact) };
}

// ---------------------------------------------------------------- adapter

export const fsAdapter: Adapter = {
  id: "fs",
  capabilities: { read: true, write: true, dryRun: true, rollback: true },

  async audit(node, ctx) {
    return templateOf(node) ? auditTemplate(node, ctx) : auditEmbedded(node, ctx);
  },

  async apply(node, ctx): Promise<ApplyResult> {
    let update: FsUpdate;
    try {
      update = await computeFsUpdate(node, ctx);
    } catch (e) {
      return { artifact: node.id, ok: false, changes: [], error: (e as Error).message };
    }
    if (update.error) return { artifact: node.id, ok: false, changes: [], error: update.error };
    if (update.before && update.before.equals(update.after)) {
      return { artifact: node.id, ok: true, changes: [] };
    }
    if (ctx.dryRun) return { artifact: node.id, ok: true, changes: update.changes.map((c) => `would ${c}`) };

    const abs = resolveInRoot(ctx.root, update.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, update.after);
    const undo: UndoRecord = {
      adapter: "fs",
      artifact: node.id,
      data: {
        path: update.path,
        existed: update.before !== null,
        encoding: "base64",
        content: update.before ? update.before.toString("base64") : null,
      },
    };
    return { artifact: node.id, ok: true, changes: update.changes, undo };
  },

  async revert(undo, ctx): Promise<ApplyResult> {
    const path = undo.data.path;
    if (typeof path !== "string") return { artifact: undo.artifact, ok: false, changes: [], error: "undo record has no path" };
    const abs = resolveInRoot(ctx.root, path);
    if (ctx.dryRun) return { artifact: undo.artifact, ok: true, changes: [`would restore ${path}`] };
    if (undo.data.existed === false) {
      await rm(abs, { force: true });
      return { artifact: undo.artifact, ok: true, changes: [`removed generated ${path}`] };
    }
    const content = undo.data.content;
    if (typeof content !== "string") return { artifact: undo.artifact, ok: false, changes: [], error: "undo record has no content" };
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from(content, undo.data.encoding === "base64" ? "base64" : "utf8"));
    return { artifact: undo.artifact, ok: true, changes: [`restored ${path}`] };
  },
};

