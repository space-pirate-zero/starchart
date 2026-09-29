import type { Graph } from "../core/graph.js";
import type { EdgeType } from "../core/model.js";
import type { Diff } from "./types.js";

/**
 * Shared literal matching for text-bearing adapters (fs, url, appstore): expanding the facts an
 * artifact embeds into leaves, formatting values as the text forms they appear in, finding them as
 * whole tokens, and replacing old values with new ones in a single pass.
 */

export interface LeafFact {
  id: string;
  value: unknown;
}

/**
 * Leaf facts reached from `artifactId` through `edgeTypes`. A container fact (one with incoming
 * `partOf` children, e.g. addon:pro.price = {usd, eur}) expands to its leaves, recursively.
 */
export function leafFacts(graph: Graph, artifactId: string, edgeTypes: EdgeType[] = ["embeds"]): LeafFact[] {
  const out = new Map<string, LeafFact>();
  const visit = (id: string, seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = graph.node(id);
    if (!node || node.kind !== "fact") return;
    const children = graph.incoming(id, "partOf").filter((e) => graph.node(e.from)?.kind === "fact");
    if (children.length === 0) {
      out.set(id, { id, value: node.value });
      return;
    }
    for (const c of children.sort((a, b) => a.from.localeCompare(b.from))) visit(c.from, seen);
  };
  for (const type of edgeTypes) {
    for (const e of graph.outgoing(artifactId, type)) visit(e.to, new Set());
  }
  return [...out.values()];
}

/** A value's textual forms, most specific first. Numbers also match their 2-decimal money form. */
export function textForms(value: unknown): string[] {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return [];
    const forms = [String(value)];
    const fixed = value.toFixed(2);
    if (!Number.isInteger(value) && fixed !== forms[0] && Number(fixed) === value) forms.push(fixed);
    if (Number.isInteger(value)) forms.push(fixed);
    return forms;
  }
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  if (typeof value === "bigint") return [value.toString()];
  return [];
}

/** Scalar items of a leaf value: arrays contribute each scalar element, scalars themselves. */
export function scalarItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" || typeof v === "number");
  if (typeof value === "string" || typeof value === "number") return [value];
  return [];
}

const WORD = /[\p{L}\p{N}_]/u;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isNumeric = (s: string) => /^-?\d+(?:[.,]\d+)?$/.test(s);

/** Regex source matching `token` as a whole token (not inside 14.99, 4.995, "Proton" for "Pro"). */
export function tokenPattern(token: string): string {
  const body = escapeRegex(token);
  if (isNumeric(token)) return `(?<![\\p{L}\\p{N}_]|\\d[.,])${body}(?![\\p{L}\\p{N}_]|[.,]\\d)`;
  const first = token[0] ?? "";
  const last = token[token.length - 1] ?? "";
  const before = WORD.test(first) ? "(?<![\\p{L}\\p{N}_])" : "";
  const after = WORD.test(last) ? "(?![\\p{L}\\p{N}_])" : "";
  return `${before}${body}${after}`;
}

export interface Span {
  start: number;
  end: number;
}

export interface TokenMatch extends Span {
  text: string;
}

/** Every whole-token occurrence of `token` inside `regions` (default: the whole text). */
export function findToken(text: string, token: string, regions?: Span[]): TokenMatch[] {
  if (!token) return [];
  const re = new RegExp(tokenPattern(token), "gu");
  const out: TokenMatch[] = [];
  for (const region of regions ?? [{ start: 0, end: text.length }]) {
    re.lastIndex = region.start;
    for (let m = re.exec(text); m && m.index + m[0].length <= region.end; m = re.exec(text)) {
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out;
}

/** Whether any textual form of `value` occurs in the text. Returns the first match. */
export function findValue(text: string, value: unknown, regions?: Span[]): TokenMatch | undefined {
  for (const form of textForms(value)) {
    const hit = findToken(text, form, regions)[0];
    if (hit) return hit;
  }
  return undefined;
}

export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One scalar old→new substitution derived from a changed fact. */
export interface Replacement {
  fact: string;
  from: unknown;
  to: unknown;
}

export interface ReplacementPlan {
  replacements: Replacement[];
  /** Old values that equal another embedded fact's current value: replacing them would corrupt it. */
  ambiguous: { fact: string; value: unknown; conflictsWith: string }[];
  /** Added list items with no old counterpart: they cannot be placed by find-and-replace. */
  unplaced: { fact: string; value: unknown }[];
}

/**
 * Substitutions needed to move text from the lock's fact values to the current ones.
 * Lists are paired element by element; elements added beyond the old length are reported as unplaced.
 */
export function planReplacements(facts: LeafFact[], previous: Record<string, unknown>): ReplacementPlan {
  const plan: ReplacementPlan = { replacements: [], ambiguous: [], unplaced: [] };
  const currentScalars = new Map<string, string>();
  for (const f of facts) for (const item of scalarItems(f.value)) currentScalars.set(JSON.stringify(item), f.id);

  for (const f of facts) {
    if (!(f.id in previous)) continue;
    const old = previous[f.id];
    if (sameValue(old, f.value)) continue;
    const pairs: [unknown, unknown][] = [];
    const current: unknown = f.value;
    if (Array.isArray(old) && Array.isArray(current)) {
      const removed = old.filter((o) => !current.some((n: unknown) => sameValue(n, o)));
      const added = current.filter((n: unknown) => !old.some((o) => sameValue(n, o)));
      for (let i = 0; i < added.length; i++) {
        if (i < removed.length) pairs.push([removed[i], added[i]]);
        else plan.unplaced.push({ fact: f.id, value: added[i] });
      }
    } else if (scalarItems(old).length === 1 && scalarItems(f.value).length === 1 && !Array.isArray(old)) {
      pairs.push([old, f.value]);
    }
    for (const [from, to] of pairs) {
      const owner = currentScalars.get(JSON.stringify(from));
      if (owner !== undefined && owner !== f.id) {
        plan.ambiguous.push({ fact: f.id, value: from, conflictsWith: owner });
        continue;
      }
      plan.replacements.push({ fact: f.id, from, to });
    }
  }
  return plan;
}

/** Renders `to` in the same style as the matched text of `from` (e.g. "5.00" stays 2-decimal). */
function formatLike(matched: string, to: unknown): string {
  if (typeof to === "number" && /^-?\d+\.\d{2}$/.test(matched)) return to.toFixed(2);
  return textForms(to)[0] ?? String(to);
}

export interface ReplaceOutcome {
  text: string;
  count: number;
  /** Per-fact number of substitutions made. */
  byFact: Record<string, number>;
}

/**
 * Applies every replacement in one pass (so 4.99→5.99 and 5.99→6.99 never chain), restricted to
 * `regions` when given. Overlapping matches keep the earliest, longest one.
 */
export function applyReplacements(text: string, replacements: Replacement[], regions?: Span[]): ReplaceOutcome {
  const hits: (TokenMatch & { r: Replacement })[] = [];
  for (const r of replacements) {
    for (const form of textForms(r.from)) for (const m of findToken(text, form, regions)) hits.push({ ...m, r });
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = 0;
  const byFact: Record<string, number> = {};
  let count = 0;
  for (const h of hits) {
    if (h.start < cursor) continue;
    out += text.slice(cursor, h.start) + formatLike(h.text, h.r.to);
    cursor = h.end;
    count++;
    byFact[h.r.fact] = (byFact[h.r.fact] ?? 0) + 1;
  }
  out += text.slice(cursor);
  return { text: out, count, byFact };
}

export interface AuditTextOptions {
  artifact: string;
  text: string;
  facts: LeafFact[];
  previous: Record<string, unknown>;
  regions?: Span[];
  /** Describes a match position, e.g. "web/pricing.tsx:12". */
  where: (index: number) => string;
  /** Location reported for a missing value (default: where(0)). */
  whereMissing?: string;
  field?: string;
}

/**
 * Stale/missing check: an old value (lock) still present is "stale"; a current value absent is
 * "missing". Old values that are also another fact's current value are not reported as stale.
 */
export function auditText(opts: AuditTextOptions): Diff[] {
  const diffs: Diff[] = [];
  const currentScalars = new Set<string>();
  for (const f of opts.facts) for (const item of scalarItems(f.value)) currentScalars.add(JSON.stringify(item));

  for (const f of opts.facts) {
    const items = scalarItems(f.value);
    if (items.length === 0) continue;
    let staleReported = false;
    if (f.id in opts.previous && !sameValue(opts.previous[f.id], f.value)) {
      for (const oldItem of scalarItems(opts.previous[f.id])) {
        if (currentScalars.has(JSON.stringify(oldItem))) continue;
        const occurrences = textForms(oldItem).flatMap((form) => findToken(opts.text, form, opts.regions));
        const first = occurrences.sort((a, b) => a.start - b.start)[0];
        if (!first) continue;
        staleReported = true;
        diffs.push({
          artifact: opts.artifact,
          fact: f.id,
          field: opts.field,
          kind: "stale",
          expected: f.value,
          actual: oldItem,
          message: `still shows old value ${JSON.stringify(oldItem)}${occurrences.length > 1 ? ` (${occurrences.length} occurrences)` : ""}; expected ${JSON.stringify(f.value)}`,
          where: opts.where(first.start),
        });
      }
    }
    if (staleReported) continue;
    const absent = items.filter((item) => !findValue(opts.text, item, opts.regions));
    if (absent.length > 0) {
      diffs.push({
        artifact: opts.artifact,
        fact: f.id,
        field: opts.field,
        kind: "missing",
        expected: f.value,
        message: `does not contain ${absent.map((a) => JSON.stringify(a)).join(", ")}`,
        where: opts.whereMissing ?? opts.where(0),
      });
    }
  }
  return diffs;
}
