import type { LexComment, LexLang, Token } from "./lexer.js";
import type { AnnotationComment, NameRef, SymbolDecl } from "./types.js";
import { hashText, type LiteralValue } from "./util.js";

/** Shared declaration-scanning machinery for the Swift, Kotlin and Go extractors. */

export const isP = (tk: Token | undefined, v: string): boolean => tk !== undefined && tk.k === "p" && tk.v === v;
export const isId = (tk: Token | undefined, v?: string): boolean => tk !== undefined && tk.k === "id" && (v === undefined || tk.v === v);

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

const SWIFT_KOTLIN_CONT_NEXT = new Set([
  ".", "?.", "{", "->", "&&", "||", "??", "?", ":", "=", "==", "!=", "===", "!==", ",", "+", "*", "/", "%",
  "<", ">", "<=", ">=", "&", "|", "^", "..", "...", "..<", "?:", "::", "as", "is",
]);
const SWIFT_KOTLIN_CONT_WORDS = new Set(["where", "get", "set", "willSet", "didSet", "throws", "rethrows", "async", "as", "is", "by", "in"]);
const SWIFT_KOTLIN_CONT_PREV = new Set([
  "=", ".", ",", "+", "-", "*", "/", "%", "&&", "||", "??", "?", ":", "->", "==", "!=", "<", ">", "<=", ">=", "&", "|", "^",
  "(", "[", "..", "...", "..<", "?:", "::", "+=", "-=", "*=", "/=",
]);

export type Continuation = (prev: Token, next: Token) => boolean;

/** Swift/Kotlin: does a statement continue from `prev` (end of a line) to `next` (start of the next line)? */
export const continuesSwiftKotlin: Continuation = (prev, next) => {
  if (next.k === "p" && SWIFT_KOTLIN_CONT_NEXT.has(next.v)) return true;
  if (next.k === "id" && SWIFT_KOTLIN_CONT_WORDS.has(next.v)) return true;
  if (prev.k === "p" && SWIFT_KOTLIN_CONT_PREV.has(prev.v)) return true;
  return false;
};

/** Go: the spec's automatic semicolon insertion rule. */
export const continuesGo: Continuation = (prev) => {
  if (prev.k === "id" || prev.k === "num" || prev.k === "str" || prev.k === "char") return false;
  if (prev.k === "p" && (prev.v === ")" || prev.v === "]" || prev.v === "}" || prev.v === "++" || prev.v === "--")) return false;
  return true;
};

/**
 * Index of the last token of the statement starting at `i`, never past `limit - 1`.
 * Stops at `;`, at a closer belonging to the enclosing block, or at a line break that
 * does not continue the statement.
 */
export function scanEnd(tokens: Token[], match: Int32Array, i: number, limit: number, cont: Continuation): number {
  let j = i;
  while (j < limit) {
    const tk = tokens[j]!;
    if (tk.k === "p") {
      if (OPENERS.has(tk.v)) {
        const m = match[j]!;
        if (m < 0 || m >= limit) return limit - 1;
        j = m;
      } else if (CLOSERS.has(tk.v)) {
        return Math.max(i, j - 1);
      } else if (tk.v === ";") {
        return Math.max(i, j - 1);
      }
    }
    const cur = tokens[j]!;
    const next = tokens[j + 1];
    if (!next || j + 1 >= limit) return j;
    if (next.line > cur.endLine && !cont(cur, next)) return j;
    j++;
  }
  return limit - 1;
}

/** Walks back from a declaration keyword over modifiers and attributes (`@MainActor`, `private(set)`). */
export function declStart(tokens: Token[], match: Int32Array, k: number, lower: number, modifiers: ReadonlySet<string>): number {
  let s = k;
  for (;;) {
    const p = s - 1;
    if (p < lower) break;
    const tk = tokens[p]!;
    if (tk.k === "id" && modifiers.has(tk.v)) {
      s = p;
      continue;
    }
    if (isP(tk, ")")) {
      const o = match[p]!;
      if (o - 1 < lower || o < 0) break;
      const before = tokens[o - 1]!;
      if (before.k === "id" && o - 2 >= lower && isP(tokens[o - 2], "@")) {
        s = o - 2;
        continue;
      }
      if (before.k === "id" && modifiers.has(before.v)) {
        s = o - 1;
        continue;
      }
      break;
    }
    if (tk.k === "id" && p - 1 >= lower && isP(tokens[p - 1], "@")) {
      s = p - 1;
      continue;
    }
    // Kotlin use-site targets: @field:Json / @get:JvmName
    if (tk.k === "id" && p - 3 >= lower && isP(tokens[p - 1], ":") && isId(tokens[p - 2]) && isP(tokens[p - 3], "@")) {
      s = p - 3;
      continue;
    }
    break;
  }
  return s;
}

export function hashTokens(tokens: Token[], from: number, to: number): string {
  const parts: string[] = [];
  for (let i = from; i <= to; i++) parts.push(tokens[i]!.v);
  return hashText(parts.join(" "));
}

/** Index of the first `{` at bracket depth 0 in [from, to], or -1. */
export function findBody(tokens: Token[], match: Int32Array, from: number, to: number): number {
  for (let j = from; j <= to; j++) {
    const tk = tokens[j]!;
    if (tk.k !== "p") continue;
    if (tk.v === "{") return j;
    if ((tk.v === "(" || tk.v === "[") && match[j]! > j) j = match[j]!;
  }
  return -1;
}

/** Index of the first `=` at bracket depth 0 in [from, to], or -1. */
export function findAssign(tokens: Token[], match: Int32Array, from: number, to: number): number {
  for (let j = from; j <= to; j++) {
    const tk = tokens[j]!;
    if (tk.k !== "p") continue;
    if (tk.v === "=") return j;
    if (OPENERS.has(tk.v) && match[j]! > j) j = match[j]!;
  }
  return -1;
}

const KOTLIN_LIST_FUNCS = new Set(["listOf", "arrayOf", "setOf", "mutableListOf", "arrayListOf", "mutableSetOf", "hashSetOf", "linkedSetOf"]);
const KOTLIN_EMPTY_LIST = new Set(["emptyList", "emptySet", "emptyArray"]);
const KOTLIN_MAP_FUNCS = new Set(["mapOf", "mutableMapOf", "hashMapOf", "linkedMapOf"]);

/**
 * Parses the literal spanning exactly tokens [from, to]. Returns undefined for anything
 * that is not a pure literal (strings, numbers, booleans, arrays and maps of those).
 */
export function parseLiteralRange(tokens: Token[], match: Int32Array, from: number, to: number, lang: LexLang): LiteralValue | undefined {
  if (from > to) return undefined;
  const res = parseLiteral(tokens, match, from, to, lang);
  if (!res || res.next !== to + 1) return undefined;
  return res.value;
}

interface LitResult {
  value: LiteralValue;
  next: number;
}

function parseLiteral(tokens: Token[], match: Int32Array, i: number, to: number, lang: LexLang): LitResult | undefined {
  const tk = tokens[i];
  if (!tk || i > to) return undefined;
  if (tk.k === "str") return tk.s === undefined ? undefined : { value: tk.s, next: i + 1 };
  if (tk.k === "num") return tk.n === undefined ? undefined : { value: tk.n, next: i + 1 };
  if (tk.k === "p" && tk.v === "-") {
    const nx = tokens[i + 1];
    if (nx?.k === "num" && nx.n !== undefined && i + 1 <= to) return { value: -nx.n, next: i + 2 };
    return undefined;
  }
  if (tk.k === "id" && (tk.v === "true" || tk.v === "false")) return { value: tk.v === "true", next: i + 1 };

  if (lang === "swift" && isP(tk, "[")) {
    const close = match[i]!;
    if (close < 0 || close > to) return undefined;
    if (isP(tokens[i + 1], ":") && close === i + 2) return { value: {}, next: close + 1 };
    const items = splitTopLevel(tokens, match, i + 1, close - 1);
    if (items.length === 0) return { value: [], next: close + 1 };
    const colon = items.map(([s, e]) => findTopLevel(tokens, match, s, e, ":"));
    if (colon.every((c) => c >= 0)) {
      const obj: Record<string, LiteralValue> = {};
      for (let n = 0; n < items.length; n++) {
        const [s, e] = items[n]!;
        const key = parseLiteralRange(tokens, match, s, colon[n]! - 1, lang);
        const val = parseLiteralRange(tokens, match, colon[n]! + 1, e, lang);
        if ((typeof key !== "string" && typeof key !== "number") || val === undefined) return undefined;
        obj[String(key)] = val;
      }
      return { value: obj, next: close + 1 };
    }
    if (colon.some((c) => c >= 0)) return undefined;
    const arr: LiteralValue[] = [];
    for (const [s, e] of items) {
      const v = parseLiteralRange(tokens, match, s, e, lang);
      if (v === undefined) return undefined;
      arr.push(v);
    }
    return { value: arr, next: close + 1 };
  }

  if (lang === "kotlin" && tk.k === "id" && (KOTLIN_LIST_FUNCS.has(tk.v) || KOTLIN_MAP_FUNCS.has(tk.v) || KOTLIN_EMPTY_LIST.has(tk.v))) {
    let j = i + 1;
    if (isP(tokens[j], "<")) {
      while (j <= to && !isP(tokens[j], "(")) {
        const t2 = tokens[j]!;
        if (t2.k === "p" && !["<", ">", ",", "?", ".", ">>"].includes(t2.v)) return undefined;
        j++;
      }
    }
    if (!isP(tokens[j], "(")) return undefined;
    const close = match[j]!;
    if (close < 0 || close > to) return undefined;
    const items = splitTopLevel(tokens, match, j + 1, close - 1);
    if (KOTLIN_EMPTY_LIST.has(tk.v)) return items.length === 0 ? { value: [], next: close + 1 } : undefined;
    if (KOTLIN_MAP_FUNCS.has(tk.v)) {
      const obj: Record<string, LiteralValue> = {};
      for (const [s, e] of items) {
        let to2 = -1;
        for (let q = s; q <= e; q++) if (isId(tokens[q], "to")) to2 = q;
        if (to2 < 0) return undefined;
        const key = parseLiteralRange(tokens, match, s, to2 - 1, lang);
        const val = parseLiteralRange(tokens, match, to2 + 1, e, lang);
        if ((typeof key !== "string" && typeof key !== "number") || val === undefined) return undefined;
        obj[String(key)] = val;
      }
      return { value: obj, next: close + 1 };
    }
    const arr: LiteralValue[] = [];
    for (const [s, e] of items) {
      const v = parseLiteralRange(tokens, match, s, e, lang);
      if (v === undefined) return undefined;
      arr.push(v);
    }
    return { value: arr, next: close + 1 };
  }

  if (lang === "go" && (isP(tk, "[") || isId(tk, "map"))) {
    // []T{...} / [N]T{...} / map[K]V{...}
    let j = i;
    let isMap = false;
    if (isId(tk, "map")) {
      isMap = true;
      j++;
    }
    if (!isP(tokens[j], "[")) return undefined;
    const closeBr = match[j]!;
    if (closeBr < 0 || closeBr > to) return undefined;
    j = closeBr + 1;
    while (j <= to && !isP(tokens[j], "{")) {
      const t2 = tokens[j]!;
      if (!(t2.k === "id" || isP(t2, ".") || isP(t2, "*"))) return undefined;
      j++;
    }
    if (!isP(tokens[j], "{")) return undefined;
    const close = match[j]!;
    if (close < 0 || close > to) return undefined;
    const items = splitTopLevel(tokens, match, j + 1, close - 1);
    if (isMap) {
      const obj: Record<string, LiteralValue> = {};
      for (const [s, e] of items) {
        const c = findTopLevel(tokens, match, s, e, ":");
        if (c < 0) return undefined;
        const key = parseLiteralRange(tokens, match, s, c - 1, lang);
        const val = parseLiteralRange(tokens, match, c + 1, e, lang);
        if ((typeof key !== "string" && typeof key !== "number") || val === undefined) return undefined;
        obj[String(key)] = val;
      }
      return { value: obj, next: close + 1 };
    }
    const arr: LiteralValue[] = [];
    for (const [s, e] of items) {
      const v = parseLiteralRange(tokens, match, s, e, lang);
      if (v === undefined) return undefined;
      arr.push(v);
    }
    return { value: arr, next: close + 1 };
  }
  return undefined;
}

/** Splits [from, to] on top-level commas; a trailing comma is allowed. */
export function splitTopLevel(tokens: Token[], match: Int32Array, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let s = from;
  for (let j = from; j <= to; j++) {
    const tk = tokens[j]!;
    if (tk.k === "p" && OPENERS.has(tk.v) && match[j]! > j) {
      j = match[j]!;
      continue;
    }
    if (isP(tk, ",")) {
      if (j > s) out.push([s, j - 1]);
      s = j + 1;
    }
  }
  if (s <= to) out.push([s, to]);
  return out;
}

function findTopLevel(tokens: Token[], match: Int32Array, from: number, to: number, v: string): number {
  for (let j = from; j <= to; j++) {
    const tk = tokens[j]!;
    if (tk.k === "p" && OPENERS.has(tk.v) && match[j]! > j) {
      j = match[j]!;
      continue;
    }
    if (isP(tk, v)) return j;
  }
  return -1;
}

/** A declaration with its token span, as produced by a language scanner. */
export interface TokenDecl {
  decl: SymbolDecl;
  from: number;
  to: number;
  /** Qualified name of the innermost type this declaration is or belongs to. */
  owner?: string;
}

/**
 * For each token, the index (into `decls`) of the innermost declaration covering it, or -1.
 * Outer spans are painted first so inner declarations overwrite them.
 */
export function paintOwners(count: number, decls: TokenDecl[]): Int32Array {
  const paint = new Int32Array(count).fill(-1);
  const order = decls.map((_, i) => i).sort((a, b) => decls[b]!.to - decls[b]!.from - (decls[a]!.to - decls[a]!.from));
  for (const i of order) {
    const d = decls[i]!;
    for (let t = d.from; t <= d.to && t < count; t++) paint[t] = i;
  }
  return paint;
}

/**
 * Collects identifier chains (`A.b.c`, `.caseName`, `self.x`) with the innermost declaration
 * covering each, for later scope-wide name resolution.
 */
export function collectNameRefs(
  tokens: Token[],
  decls: TokenDecl[],
  paint: Int32Array,
  keywords: ReadonlySet<string>,
  selfWords: ReadonlySet<string>,
): NameRef[] {
  const refs: NameRef[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]!;
    if (tk.k !== "id") continue;
    const prev = tokens[i - 1];
    const afterDot = isP(prev, ".") || isP(prev, "?.");
    let leadingDot = false;
    if (afterDot) {
      const before = tokens[i - 2];
      const isReceiver = before && (before.k === "id" || before.k === "str" || before.k === "num" || isP(before, ")") || isP(before, "]") || isP(before, "}") || isP(before, "?") || isP(before, "!"));
      if (isReceiver) continue;
      leadingDot = true;
    }
    if (!selfWords.has(tk.v) && keywords.has(tk.v)) continue;
    const chain = [tk.v];
    let j = i;
    while ((isP(tokens[j + 1], ".") || isP(tokens[j + 1], "?.")) && isId(tokens[j + 2])) {
      chain.push(tokens[j + 2]!.v);
      j += 2;
    }
    if (selfWords.has(tk.v) && chain.length === 1) continue;
    const di = paint[i]!;
    const d = di >= 0 ? decls[di] : undefined;
    refs.push({ from: d?.decl.id, chain, leadingDot: leadingDot || undefined, owner: d?.owner, line: tk.line });
    i = j;
  }
  return refs;
}

/** Lines covered by at least one token. */
export function codeLinesFromTokens(tokens: Token[]): Set<number> {
  const lines = new Set<number>();
  for (const tk of tokens) for (let l = tk.line; l <= tk.endLine; l++) lines.add(l);
  return lines;
}

/** Comments carrying `@starchart`, flagged as trailing when a token precedes them on the same line. */
export function annotationComments(comments: LexComment[], tokens: Token[]): AnnotationComment[] {
  const out: AnnotationComment[] = [];
  for (const c of comments) {
    if (!c.text.includes("@starchart")) continue;
    let lo = 0;
    let hi = tokens.length - 1;
    let before = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tokens[mid]!.pos < c.pos) {
        before = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const trailing = before >= 0 && tokens[before]!.endLine === c.line;
    out.push({ text: c.text, line: c.line, endLine: c.endLine, trailing });
  }
  return out;
}

/** First call argument when it is a string literal: `f("x")`, `f(key: "x")`, `f(key = "x")`. */
export function firstStringArg(tokens: Token[], open: number): string | undefined {
  if (!isP(tokens[open], "(")) return undefined;
  let j = open + 1;
  if (isId(tokens[j]) && (isP(tokens[j + 1], ":") || isP(tokens[j + 1], "="))) j += 2;
  const tk = tokens[j];
  if (tk?.k !== "str" || tk.s === undefined) return undefined;
  const after = tokens[j + 1];
  if (!(isP(after, ")") || isP(after, ","))) return undefined;
  return tk.s;
}
