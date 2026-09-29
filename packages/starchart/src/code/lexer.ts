import { computeLineStarts, lineAt } from "./util.js";

/**
 * A small, forgiving lexer for Swift, Kotlin and Go. It understands enough of each
 * language to skip comments (including nested block comments) and string contents
 * (multi-line and raw strings, Swift `\( )` and Kotlin `${ }` interpolation), so that
 * brace matching and declaration scanning never trip over text inside literals.
 * Tokens inside interpolations are emitted too, so references there are still seen.
 */

export type LexLang = "swift" | "kotlin" | "go";
export type TokKind = "id" | "str" | "num" | "char" | "p";

export interface Token {
  k: TokKind;
  /** Source text (identifier name without backticks; punctuation; raw literal text). */
  v: string;
  /** Decoded value of a non-interpolated string literal. */
  s?: string;
  /** Parsed value of a number literal. */
  n?: number;
  interp?: boolean;
  line: number;
  endLine: number;
  pos: number;
  end: number;
}

export interface LexComment {
  text: string;
  pos: number;
  end: number;
  line: number;
  endLine: number;
}

export interface LexResult {
  tokens: Token[];
  comments: LexComment[];
  /** For every bracket token, the index of its partner (or -1); -1 for other tokens. */
  match: Int32Array;
  lineStarts: number[];
}

const OP_CHARS = new Set(["+", "-", "*", "/", "%", "<", ">", "!", "&", "|", "^", "~", "?"]);

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

function isIdentStart(c: string | undefined): boolean {
  if (c === undefined) return false;
  if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") return true;
  return c.charCodeAt(0) > 127 && /\p{L}/u.test(c);
}

function isIdentPart(c: string | undefined): boolean {
  if (c === undefined) return false;
  if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_") return true;
  return c.charCodeAt(0) > 127 && /[\p{L}\p{N}]/u.test(c);
}

class Lexer {
  i = 0;
  readonly tokens: Token[] = [];
  readonly comments: LexComment[] = [];

  constructor(
    private readonly text: string,
    private readonly lang: LexLang,
    private readonly starts: number[],
  ) {}

  private tok(out: Token[], k: TokKind, v: string, pos: number, end: number, extra?: Partial<Token>): void {
    const line = lineAt(this.starts, pos);
    const endLine = k === "str" || k === "p" ? lineAt(this.starts, Math.max(pos, end - 1)) : line;
    out.push({ k, v, line, endLine, pos, end, ...extra });
  }

  /**
   * Lexes until `closer` is found at bracket depth 0 (consumed, not emitted) or input ends.
   * `stopAtNewline` guards single-line string interpolations against unterminated input.
   */
  run(out: Token[], closer: string | null, stopAtNewline = false): void {
    const t = this.text;
    const n = t.length;
    let depth = 0;
    while (this.i < n) {
      const c = t[this.i]!;
      if (c === "\n" && stopAtNewline) return;
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === "﻿") {
        this.i++;
        continue;
      }
      if (c === "/" && t[this.i + 1] === "/") {
        const start = this.i;
        let j = t.indexOf("\n", start);
        if (j < 0) j = n;
        this.comment(start, j);
        this.i = j;
        continue;
      }
      if (c === "/" && t[this.i + 1] === "*") {
        const start = this.i;
        this.i = this.blockCommentEnd(start);
        this.comment(start, this.i);
        continue;
      }
      if (closer !== null && depth === 0 && c === closer) {
        this.i++;
        return;
      }
      if (c === "(" || c === "[" || c === "{") {
        depth++;
        this.tok(out, "p", c, this.i, this.i + 1);
        this.i++;
        continue;
      }
      if (c === ")" || c === "]" || c === "}") {
        depth--;
        this.tok(out, "p", c, this.i, this.i + 1);
        this.i++;
        continue;
      }
      if (this.lexString(out)) continue;
      if (isDigit(c)) {
        this.lexNumber(out);
        continue;
      }
      if (isIdentStart(c) || (c === "$" && this.lang === "swift" && (isIdentPart(t[this.i + 1]) || isDigit(t[this.i + 1])))) {
        const start = this.i;
        this.i++;
        while (this.i < n && isIdentPart(t[this.i])) this.i++;
        this.tok(out, "id", t.slice(start, this.i), start, this.i);
        continue;
      }
      if (c === "`" && this.lang !== "go") {
        const close = t.indexOf("`", this.i + 1);
        const nl = t.indexOf("\n", this.i + 1);
        if (close > this.i && (nl < 0 || close < nl)) {
          this.tok(out, "id", t.slice(this.i + 1, close), this.i, close + 1);
          this.i = close + 1;
          continue;
        }
      }
      this.lexPunct(out);
    }
  }

  private comment(start: number, end: number): void {
    this.comments.push({
      text: this.text.slice(start, end),
      pos: start,
      end,
      line: lineAt(this.starts, start),
      endLine: lineAt(this.starts, Math.max(start, end - 1)),
    });
  }

  private blockCommentEnd(start: number): number {
    const t = this.text;
    const nested = this.lang !== "go";
    let depth = 0;
    let j = start;
    while (j < t.length) {
      if (t[j] === "/" && t[j + 1] === "*") {
        depth++;
        j += 2;
        if (!nested && depth > 1) depth = 1;
        continue;
      }
      if (t[j] === "*" && t[j + 1] === "/") {
        depth--;
        j += 2;
        if (depth === 0) return j;
        continue;
      }
      j++;
    }
    return t.length;
  }

  private lexNumber(out: Token[]): void {
    const t = this.text;
    const start = this.i;
    let j = start;
    let radix = false;
    if (t[j] === "0" && /[xXbBoO]/.test(t[j + 1] ?? "")) {
      radix = true;
      j += 2;
      while (j < t.length && /[0-9a-fA-F_]/.test(t[j]!)) j++;
      while (j < t.length && /[uUlL]/.test(t[j]!)) j++;
    } else {
      while (j < t.length && (isDigit(t[j]) || t[j] === "_")) j++;
      if (t[j] === "." && isDigit(t[j + 1])) {
        j++;
        while (j < t.length && (isDigit(t[j]) || t[j] === "_")) j++;
      }
      if ((t[j] === "e" || t[j] === "E") && (isDigit(t[j + 1]) || ((t[j + 1] === "+" || t[j + 1] === "-") && isDigit(t[j + 2])))) {
        j += 2;
        while (j < t.length && isDigit(t[j])) j++;
      }
      while (j < t.length && /[a-zA-Z]/.test(t[j]!)) j++;
    }
    const raw = t.slice(start, j);
    this.i = j;
    this.tok(out, "num", raw, start, j, { n: parseNumber(raw, radix) });
  }

  private lexPunct(out: Token[]): void {
    const t = this.text;
    const start = this.i;
    const c = t[start]!;
    let end = start + 1;
    if (c === ".") {
      if (t.startsWith("...", start)) end = start + 3;
      else if (t.startsWith("..<", start)) end = start + 3;
      else if (t[start + 1] === ".") end = start + 2;
    } else if (c === "=") {
      if (t[start + 1] === "=") end = t[start + 2] === "=" ? start + 3 : start + 2;
    } else if (c === ":") {
      if (t[start + 1] === ":" && this.lang === "kotlin") end = start + 2;
      else if (t[start + 1] === "=" && this.lang === "go") end = start + 2;
    } else if (OP_CHARS.has(c)) {
      while (end < t.length) {
        const d = t[end]!;
        if (d === "/" && (t[end + 1] === "/" || t[end + 1] === "*")) break;
        if (OP_CHARS.has(d) || d === "=") end++;
        else break;
      }
    }
    this.i = end;
    this.tok(out, "p", t.slice(start, end), start, end);
  }

  /** Lexes a string/char literal at the cursor. Returns false when none starts here. */
  private lexString(out: Token[]): boolean {
    const t = this.text;
    const c = t[this.i]!;
    if (this.lang === "swift") {
      let hashes = 0;
      while (t[this.i + hashes] === "#") hashes++;
      if (t[this.i + hashes] !== '"') return false;
      this.lexSwiftString(out, hashes);
      return true;
    }
    if (this.lang === "kotlin") {
      if (c === '"') {
        this.lexKotlinString(out);
        return true;
      }
      if (c === "'") return this.lexChar(out);
      return false;
    }
    // go
    if (c === '"') {
      this.lexGoString(out);
      return true;
    }
    if (c === "`") {
      const start = this.i;
      let end = t.indexOf("`", start + 1);
      end = end < 0 ? t.length : end + 1;
      this.i = end;
      this.tok(out, "str", t.slice(start, end), start, end, { s: t.slice(start + 1, Math.max(start + 1, end - 1)).replace(/\r/g, "") });
      return true;
    }
    if (c === "'") return this.lexChar(out);
    return false;
  }

  private lexChar(out: Token[]): boolean {
    const t = this.text;
    const start = this.i;
    let j = start + 1;
    if (t[j] === "\\") j += 2;
    else j++;
    while (j < t.length && j - start < 12 && t[j] !== "'" && t[j] !== "\n") j++;
    if (t[j] !== "'") {
      // not a char literal after all; treat the quote as punctuation
      this.i = start + 1;
      this.tok(out, "p", "'", start, start + 1);
      return true;
    }
    this.i = j + 1;
    this.tok(out, "char", t.slice(start, j + 1), start, j + 1, { s: decodeEscapes(t.slice(start + 1, j), this.lang, 0) });
    return true;
  }

  private lexSwiftString(out: Token[], hashes: number): void {
    const t = this.text;
    const start = this.i;
    let j = start + hashes;
    const multi = t.startsWith('"""', j);
    j += multi ? 3 : 1;
    const contentStart = j;
    const pounds = "#".repeat(hashes);
    const closing = (multi ? '"""' : '"') + pounds;
    const inner: Token[] = [];
    let interp = false;
    let contentEnd = t.length;
    let closed = false;
    while (j < t.length) {
      if (t.startsWith(closing, j)) {
        contentEnd = j;
        j += closing.length;
        closed = true;
        break;
      }
      const ch = t[j]!;
      if (!multi && ch === "\n") {
        contentEnd = j;
        break;
      }
      if (ch === "\\" && t.startsWith(pounds, j + 1)) {
        const k = j + 1 + hashes;
        if (t[k] === "(") {
          this.i = k + 1;
          this.run(inner, ")", !multi);
          j = this.i;
          interp = true;
          continue;
        }
        j = k + 1;
        continue;
      }
      j++;
    }
    if (!closed && j >= t.length) contentEnd = t.length;
    this.i = j;
    let value: string | undefined;
    if (!interp) {
      let raw = t.slice(contentStart, contentEnd).replace(/\r/g, "");
      if (multi) raw = dedentSwiftMultiline(raw);
      value = decodeEscapes(raw, "swift", hashes);
    }
    this.tok(out, "str", t.slice(start, j), start, j, interp ? { interp: true } : { s: value });
    for (const tk of inner) out.push(tk);
  }

  private lexKotlinString(out: Token[]): void {
    const t = this.text;
    const start = this.i;
    const multi = t.startsWith('"""', start);
    let j = start + (multi ? 3 : 1);
    const contentStart = j;
    let contentEnd = t.length;
    const inner: Token[] = [];
    let interp = false;
    while (j < t.length) {
      const ch = t[j]!;
      if (multi && t.startsWith('"""', j)) {
        while (t[j + 3] === '"') j++;
        contentEnd = j;
        j += 3;
        break;
      }
      if (!multi && ch === '"') {
        contentEnd = j;
        j++;
        break;
      }
      if (!multi && ch === "\n") {
        contentEnd = j;
        break;
      }
      if (!multi && ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "$" && t[j + 1] === "{") {
        this.i = j + 2;
        this.run(inner, "}", !multi);
        j = this.i;
        interp = true;
        continue;
      }
      if (ch === "$" && isIdentStart(t[j + 1])) {
        const s = j + 1;
        let e = s + 1;
        while (e < t.length && isIdentPart(t[e])) e++;
        this.tok(inner, "id", t.slice(s, e), s, e);
        j = e;
        interp = true;
        continue;
      }
      j++;
    }
    this.i = j;
    const raw = t.slice(contentStart, Math.min(contentEnd, t.length)).replace(/\r/g, "");
    const value = interp ? undefined : multi ? raw : decodeEscapes(raw, "kotlin", 0);
    this.tok(out, "str", t.slice(start, j), start, j, interp ? { interp: true } : { s: value });
    for (const tk of inner) out.push(tk);
  }

  private lexGoString(out: Token[]): void {
    const t = this.text;
    const start = this.i;
    let j = start + 1;
    let contentEnd = t.length;
    while (j < t.length) {
      const ch = t[j]!;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === '"' || ch === "\n") {
        contentEnd = j;
        if (ch === '"') j++;
        break;
      }
      j++;
    }
    this.i = j;
    this.tok(out, "str", t.slice(start, j), start, j, { s: decodeEscapes(t.slice(start + 1, Math.min(contentEnd, t.length)), "go", 0) });
  }
}

function parseNumber(raw: string, radix: boolean): number | undefined {
  let clean = raw.replace(/_/g, "");
  if (radix) clean = clean.replace(/[uUlL]+$/, "");
  else clean = clean.replace(/[a-zA-Z]+$/, "");
  const value = Number(clean);
  return Number.isFinite(value) ? value : undefined;
}

/** Applies Swift multi-line string indentation stripping to the raw content. */
function dedentSwiftMultiline(raw: string): string {
  const lines = raw.split("\n");
  if (lines.length < 2) return raw;
  const last = lines[lines.length - 1]!;
  const indent = /^[ \t]*$/.test(last) ? last : "";
  const body = lines.slice(1, /^[ \t]*$/.test(last) ? -1 : undefined);
  return body.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())).join("\n");
}

/** Decodes backslash escapes. `hashes` is the Swift extended-delimiter count. */
export function decodeEscapes(raw: string, lang: LexLang, hashes: number): string {
  const esc = "\\" + "#".repeat(hashes);
  if (!raw.includes(esc)) return raw;
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (!raw.startsWith(esc, i)) {
      out += raw[i];
      i++;
      continue;
    }
    const k = i + esc.length;
    const c = raw[k];
    i = k + 1;
    switch (c) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "0":
        if (lang === "go" && /^[0-7]{3}$/.test(raw.slice(k, k + 3))) {
          out += String.fromCharCode(parseInt(raw.slice(k, k + 3), 8));
          i = k + 3;
        } else out += "\0";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "a":
        out += lang === "go" ? "\u0007" : "a";
        break;
      case "\n":
        // Swift multi-line line continuation
        break;
      case "x": {
        const hex = raw.slice(k + 1, k + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i = k + 3;
        } else out += "x";
        break;
      }
      case "u": {
        if (raw[k + 1] === "{") {
          const close = raw.indexOf("}", k + 2);
          const cp = close > 0 ? parseInt(raw.slice(k + 2, close), 16) : NaN;
          if (Number.isFinite(cp)) {
            out += String.fromCodePoint(cp);
            i = close + 1;
          } else out += "u";
        } else {
          const hex = raw.slice(k + 1, k + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i = k + 5;
          } else out += "u";
        }
        break;
      }
      case "U": {
        const hex = raw.slice(k + 1, k + 9);
        if (/^[0-9a-fA-F]{8}$/.test(hex)) {
          out += String.fromCodePoint(parseInt(hex, 16));
          i = k + 9;
        } else out += "U";
        break;
      }
      case undefined:
        out += "\\";
        break;
      default:
        out += c;
    }
  }
  return out;
}

export function computeMatches(tokens: Token[]): Int32Array {
  const match = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  const pair: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]!;
    if (tk.k !== "p") continue;
    const v = tk.v;
    if (v === "(" || v === "[" || v === "{") stack.push(i);
    else if (v === ")" || v === "]" || v === "}") {
      const want = pair[v]!;
      let found = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (tokens[stack[s]!]!.v === want) {
          found = s;
          break;
        }
      }
      if (found < 0) continue;
      const open = stack[found]!;
      stack.length = found;
      match[open] = i;
      match[i] = open;
    }
  }
  return match;
}

export function lex(text: string, lang: LexLang): LexResult {
  const lineStarts = computeLineStarts(text);
  const lexer = new Lexer(text, lang, lineStarts);
  lexer.run(lexer.tokens, null);
  return { tokens: lexer.tokens, comments: lexer.comments, match: computeMatches(lexer.tokens), lineStarts };
}
