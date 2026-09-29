import {
  annotationComments,
  codeLinesFromTokens,
  collectNameRefs,
  continuesGo,
  findAssign,
  firstStringArg,
  hashTokens,
  isId,
  isP,
  paintOwners,
  parseLiteralRange,
  scanEnd,
  splitTopLevel,
  type TokenDecl,
} from "./clike.js";
import { addDecl, type ClikeParsed, scanSignals, uniqueSymbols } from "./clike-common.js";
import { lex, type Token } from "./lexer.js";
import type { SourceFile } from "./types.js";
import { dirnamePosix, sha16, type LiteralValue } from "./util.js";

const KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if",
  "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var", "nil", "true", "false",
]);
const NO_SELF = new Set<string>();

export function parseGo(file: SourceFile, text: string, generated: boolean): ClikeParsed {
  const { tokens, comments, match } = lex(text, "go");
  const decls: TokenDecl[] = [];
  const aliases: Record<string, string> = {};
  const imports: string[] = [];

  let pkgName = "";
  const pkgIdx = tokens.findIndex((t) => t.k === "id" && t.v === "package");
  if (pkgIdx >= 0 && isId(tokens[pkgIdx + 1])) pkgName = tokens[pkgIdx + 1]!.v;
  const relDir = dirnamePosix(file.rel);
  const namespace = relDir || pkgName || "main";
  const prefix = `symbol:${file.scope}/${namespace}.`;

  const addImport = (s: number, e: number) => {
    const pathTok = tokens[e];
    if (pathTok?.k !== "str" || pathTok.s === undefined) return;
    const path = pathTok.s;
    imports.push(path);
    let alias: string | undefined;
    if (e > s && isId(tokens[s])) alias = tokens[s]!.v;
    else if (e > s && isP(tokens[s], ".")) return;
    if (alias === "_") return;
    aliases[alias ?? defaultImportName(path)] = path;
  };

  const add = (nameTok: Token, qname: string, kind: string, s: number, e: number, value?: LiteralValue, owner?: string) => {
    addDecl(decls, {
      decl: {
        id: prefix + qname,
        name: nameTok.v,
        qname: `${namespace}.${qname}`,
        kind,
        line: tokens[s]!.line,
        endLine: tokens[e]!.endLine,
        depth: owner ? 1 : 0,
        parent: owner ? prefix + owner : undefined,
        hash: hashTokens(tokens, s, e),
        value,
        isType: kind === "type" || undefined,
        exported: /^[A-Z]/.test(nameTok.v) || undefined,
      },
      from: s,
      to: e,
      owner: owner ? `${namespace}.${owner}` : kind === "type" ? `${namespace}.${qname}` : undefined,
    });
  };

  /** Each spec of a `const`/`var`/`type` declaration, grouped or not. */
  const specs = (k: number, end: number): [number, number][] => {
    if (isP(tokens[k + 1], "(") && match[k + 1]! > k + 1) {
      const close = match[k + 1]!;
      const out: [number, number][] = [];
      let j = k + 2;
      while (j < close) {
        if (isP(tokens[j], ";")) {
          j++;
          continue;
        }
        const e = scanEnd(tokens, match, j, close, continuesGo);
        out.push([j, e]);
        j = e + 1;
      }
      return out;
    }
    return [[k + 1, end]];
  };

  let i = 0;
  while (i < tokens.length) {
    const tk = tokens[i]!;
    if (tk.k === "p") {
      if ((tk.v === "{" || tk.v === "(" || tk.v === "[") && match[i]! > i) i = match[i]! + 1;
      else i++;
      continue;
    }
    if (tk.k !== "id" || !["import", "func", "type", "const", "var"].includes(tk.v)) {
      i++;
      continue;
    }
    const kw = tk.v;
    const end = scanEnd(tokens, match, i, tokens.length, continuesGo);
    if (kw === "import") {
      for (const [s, e] of specs(i, end)) addImport(s, e);
    } else if (kw === "func") {
      let j = i + 1;
      let recv: string | undefined;
      if (isP(tokens[j], "(") && match[j]! > j) {
        const ids: string[] = [];
        for (let q = j + 1; q < match[j]!; q++) {
          const t2 = tokens[q]!;
          if (isP(t2, "[") && match[q]! > q) {
            q = match[q]!;
            continue;
          }
          if (t2.k === "id") ids.push(t2.v);
        }
        recv = ids.length >= 2 ? ids[1] : ids[0];
        j = match[j]! + 1;
      }
      const nameTok = tokens[j];
      if (isId(nameTok)) add(nameTok!, recv ? `${recv}.${nameTok!.v}` : nameTok!.v, recv ? "method" : "func", i, end, undefined, recv);
    } else if (kw === "type") {
      for (const [s, e] of specs(i, end)) {
        if (isId(tokens[s])) add(tokens[s]!, tokens[s]!.v, "type", s === i + 1 ? i : s, e);
      }
    } else {
      for (const [s, e] of specs(i, end)) {
        const names: Token[] = [];
        let j = s;
        while (isId(tokens[j])) {
          names.push(tokens[j]!);
          if (isP(tokens[j + 1], ",")) j += 2;
          else break;
        }
        const eq = findAssign(tokens, match, s, e);
        const values = eq >= 0 ? splitTopLevel(tokens, match, eq + 1, e) : [];
        names.forEach((nameTok, n) => {
          if (nameTok.v === "_") return;
          const range = values.length === names.length ? values[n] : undefined;
          const value = range ? parseLiteralRange(tokens, match, range[0], range[1], "go") : undefined;
          add(nameTok, nameTok.v, kw, s === i + 1 ? i : s, e, value);
        });
      }
    }
    i = end + 1;
  }

  const paint = paintOwners(tokens.length, decls);
  const refs = collectNameRefs(tokens, decls, paint, KEYWORDS, NO_SELF);
  const { signals, i18nRefs } = scanSignals(tokens, decls, paint, {
    env: (q) => ((tokens[q]!.v === "Getenv" || tokens[q]!.v === "LookupEnv") && isP(tokens[q + 1], "(") ? firstStringArg(tokens, q + 1) : undefined),
    i18n: () => undefined,
  });

  return {
    file,
    lang: "go",
    hash: sha16(text),
    generated,
    symbols: uniqueSymbols(decls),
    signals,
    i18nRefs,
    annotations: annotationComments(comments, tokens),
    codeLines: codeLinesFromTokens(tokens),
    screens: [],
    refs,
    imports,
    go: { name: pkgName, namespace, dir: dirnamePosix(file.path), aliases },
  };
}

/** Go's conventional package name for an import path: last element, skipping a /vN suffix. */
function defaultImportName(path: string): string {
  const segs = path.split("/");
  let last = segs.pop() ?? path;
  if (/^v\d+$/.test(last) && segs.length > 0) last = segs.pop()!;
  return last.replace(/^go-/, "").replace(/-go$/, "").replace(/\..*$/, "").replace(/-/g, "");
}
