import {
  annotationComments,
  codeLinesFromTokens,
  collectNameRefs,
  continuesSwiftKotlin,
  declStart,
  findAssign,
  findBody,
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
import { sha16, type LiteralValue } from "./util.js";

const MODIFIERS = new Set([
  "public", "private", "protected", "internal", "open", "abstract", "final", "sealed", "data", "inner", "override", "lateinit",
  "const", "suspend", "inline", "tailrec", "operator", "infix", "external", "annotation", "value", "expect", "actual", "enum",
  "companion", "noinline", "crossinline",
]);
const TYPE_KW = new Set(["class", "interface", "object"]);
const MEMBER_KW = new Set(["fun", "val", "var", "typealias"]);
const KEYWORDS = new Set([
  "val", "var", "fun", "if", "else", "when", "return", "true", "false", "null", "this", "super", "class", "object", "interface",
  "is", "as", "in", "for", "while", "do", "try", "catch", "finally", "throw", "import", "package", "it", "by", "get", "set",
]);
const SELF_WORDS = new Set(["this"]);

interface Ctx {
  path: string[];
  depth: number;
  parentId?: string;
}

export function parseKotlin(file: SourceFile, text: string, generated: boolean): ClikeParsed {
  const { tokens, comments, match } = lex(text, "kotlin");
  const decls: TokenDecl[] = [];
  const imports: string[] = [];
  const screens: { name: string; symbolId: string }[] = [];
  const prefix = `symbol:${file.scope}/`;

  const walk = (from: number, to: number, ctx: Ctx) => {
    let i = from;
    let lower = from;
    while (i < to) {
      const tk = tokens[i]!;
      if (tk.k === "p") {
        if ((tk.v === "{" || tk.v === "(" || tk.v === "[") && match[i]! > i) {
          i = match[i]! + 1;
          lower = i;
        } else i++;
        continue;
      }
      if (tk.k !== "id") {
        i++;
        continue;
      }
      const kw = tk.v;
      if ((kw === "import" || kw === "package") && ctx.depth === 0) {
        const end = scanEnd(tokens, match, i, to, continuesSwiftKotlin);
        if (kw === "import") {
          const parts: string[] = [];
          for (let j = i + 1; j <= end; j++) {
            const t2 = tokens[j]!;
            if (isId(t2, "as")) break;
            if (t2.k === "id") parts.push(t2.v);
            else if (isP(t2, "*")) parts.push("*");
          }
          if (parts.length) imports.push(parts.join("."));
        }
        i = end + 1;
        lower = i;
        continue;
      }
      if (kw === "fun" && isId(tokens[i + 1], "interface")) {
        i++;
        continue;
      }
      const isType = TYPE_KW.has(kw) && !isP(tokens[i - 1], "::") && !isP(tokens[i - 1], ".");
      const isMember = MEMBER_KW.has(kw) && !isP(tokens[i - 1], ".");
      if (!isType && !isMember) {
        i++;
        continue;
      }
      const start = declStart(tokens, match, i, lower, MODIFIERS);
      const end = scanEnd(tokens, match, i, to, continuesSwiftKotlin);
      const mods = tokens.slice(start, i).filter((t) => t.k === "id").map((t) => t.v);
      if (isType) parseType(i, start, end, kw, mods, ctx);
      else parseMember(i, start, end, kw, mods, ctx);
      i = end + 1;
      lower = i;
    }
  };

  const parseType = (k: number, start: number, end: number, kw: string, mods: string[], ctx: Ctx) => {
    const companion = kw === "object" && mods.includes("companion");
    const nameTok = tokens[k + 1];
    const named = isId(nameTok);
    const body = findBody(tokens, match, k + 1, end);
    if (companion) {
      if (body >= 0 && match[body]! > body) walk(body + 1, match[body]!, ctx);
      return;
    }
    if (!named) return;
    const name = nameTok!.v;
    const qparts = [...ctx.path, name];
    const qname = qparts.join(".");
    const id = prefix + qname;
    const kind = mods.includes("enum") ? "enum" : kw;
    addDecl(decls, {
      decl: {
        id,
        name,
        qname,
        kind,
        line: tokens[start]!.line,
        endLine: tokens[end]!.endLine,
        depth: ctx.depth,
        parent: ctx.parentId,
        hash: hashTokens(tokens, start, end),
        isType: true,
      },
      from: start,
      to: end,
      owner: qname,
    });
    if (body < 0 || match[body]! <= body) return;
    const inner: Ctx = { path: qparts, depth: ctx.depth + 1, parentId: id };
    let bodyFrom = body + 1;
    if (kind === "enum") bodyFrom = parseEnumEntries(body + 1, match[body]!, inner);
    walk(bodyFrom, match[body]!, inner);
  };

  const parseEnumEntries = (from: number, to: number, ctx: Ctx): number => {
    let j = from;
    while (j < to) {
      while (isP(tokens[j], "@") && isId(tokens[j + 1])) {
        j += 2;
        if (isP(tokens[j], "(") && match[j]! > j) j = match[j]! + 1;
      }
      const nameTok = tokens[j];
      if (!isId(nameTok) || MODIFIERS.has(nameTok!.v) || MEMBER_KW.has(nameTok!.v) || TYPE_KW.has(nameTok!.v)) return j;
      const s = j;
      j++;
      let value: LiteralValue | undefined;
      if (isP(tokens[j], "(") && match[j]! > j) {
        const args = splitTopLevel(tokens, match, j + 1, match[j]! - 1);
        if (args.length === 1) value = parseLiteralRange(tokens, match, args[0]![0], args[0]![1], "kotlin");
        j = match[j]! + 1;
      }
      if (isP(tokens[j], "{") && match[j]! > j) j = match[j]! + 1;
      const e = j - 1;
      const qname = [...ctx.path, nameTok!.v].join(".");
      addDecl(decls, {
        decl: {
          id: prefix + qname,
          name: nameTok!.v,
          qname,
          kind: "case",
          line: nameTok!.line,
          endLine: tokens[e]!.endLine,
          depth: ctx.depth,
          parent: ctx.parentId,
          hash: hashTokens(tokens, s, e),
          value,
          isStatic: true,
        },
        from: s,
        to: e,
        owner: ctx.path.join("."),
      });
      if (isP(tokens[j], ",")) {
        j++;
        continue;
      }
      if (isP(tokens[j], ";")) return j + 1;
      return j;
    }
    return j;
  };

  const parseMember = (k: number, start: number, end: number, kw: string, mods: string[], ctx: Ctx) => {
    let j = k + 1;
    if (isP(tokens[j], "<")) j = skipAngles(tokens, j);
    if (!isId(tokens[j])) return;
    const parts = [tokens[j]!.v];
    while (isP(tokens[j + 1], ".") && isId(tokens[j + 2])) {
      parts.push(tokens[j + 2]!.v);
      j += 2;
    }
    // receiver generics: fun List<String>.foo()
    if (isP(tokens[j + 1], "<")) {
      const after = skipAngles(tokens, j + 1);
      if (isP(tokens[after], ".") && isId(tokens[after + 1])) {
        parts.push(tokens[after + 1]!.v);
        j = after + 1;
      }
    }
    const name = parts[parts.length - 1]!;
    const qname = ctx.path.length ? [...ctx.path, name].join(".") : parts.join(".");
    let value: LiteralValue | undefined;
    if (kw === "val") {
      const eq = findAssign(tokens, match, j + 1, end);
      if (eq >= 0) value = parseLiteralRange(tokens, match, eq + 1, end, "kotlin");
    }
    const id = prefix + qname;
    const added = addDecl(decls, {
      decl: {
        id,
        name,
        qname,
        kind: kw,
        line: tokens[start]!.line,
        endLine: tokens[end]!.endLine,
        depth: ctx.depth,
        parent: ctx.parentId,
        hash: hashTokens(tokens, start, end),
        value,
        isStatic: ctx.depth === 0 || mods.includes("const") || undefined,
      },
      from: start,
      to: end,
      owner: ctx.path.length ? ctx.path.join(".") : undefined,
    });
    if (added && kw === "fun" && name.endsWith("Screen") && name.length > "Screen".length && hasAnnotation(tokens, start, k, "Composable")) {
      screens.push({ name: name.slice(0, -"Screen".length), symbolId: id });
    }
  };

  walk(0, tokens.length, { path: [], depth: 0 });

  const paint = paintOwners(tokens.length, decls);
  const refs = collectNameRefs(tokens, decls, paint, KEYWORDS, SELF_WORDS);
  const { signals, i18nRefs } = scanSignals(tokens, decls, paint, {
    env: (i) => (tokens[i]!.v === "getenv" && isP(tokens[i + 1], "(") ? firstStringArg(tokens, i + 1) : undefined),
    i18n: (i) => {
      if (tokens[i]!.v !== "R" || isP(tokens[i - 1], ".")) return undefined;
      if (isP(tokens[i + 1], ".") && isId(tokens[i + 2], "string") && isP(tokens[i + 3], ".") && isId(tokens[i + 4])) return tokens[i + 4]!.v;
      return undefined;
    },
  });

  return {
    file,
    lang: "kotlin",
    hash: sha16(text),
    generated,
    symbols: uniqueSymbols(decls),
    signals,
    i18nRefs,
    annotations: annotationComments(comments, tokens),
    codeLines: codeLinesFromTokens(tokens),
    screens,
    refs,
    imports,
  };
}

function skipAngles(tokens: Token[], j: number): number {
  let depth = 0;
  for (; j < tokens.length; j++) {
    const tk = tokens[j]!;
    if (tk.k !== "p") continue;
    if (tk.v === "<") depth++;
    else if (/^>+$/.test(tk.v)) depth -= tk.v.length;
    else if (tk.v === "{" || tk.v === "(" || tk.v === "=") return j;
    if (depth <= 0) return j + 1;
  }
  return j;
}

function hasAnnotation(tokens: Token[], from: number, to: number, name: string): boolean {
  for (let j = from; j < to; j++) if (isP(tokens[j], "@") && isId(tokens[j + 1], name)) return true;
  return false;
}
