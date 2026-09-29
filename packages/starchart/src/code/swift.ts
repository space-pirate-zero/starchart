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
import { lex, type Token } from "./lexer.js";
import { addDecl, type ClikeParsed, scanSignals, uniqueSymbols } from "./clike-common.js";
import type { SourceFile } from "./types.js";
import { sha16 } from "./util.js";

const MODIFIERS = new Set([
  "public", "private", "fileprivate", "internal", "open", "package", "static", "final", "override", "mutating", "nonmutating",
  "lazy", "weak", "unowned", "required", "convenience", "dynamic", "indirect", "nonisolated", "isolated", "consuming",
  "borrowing", "prefix", "postfix", "infix", "optional", "class", "distributed",
]);
const TYPE_KW = new Set(["struct", "class", "enum", "extension", "protocol", "actor"]);
const MEMBER_KW = new Set(["func", "let", "var", "init", "subscript", "typealias", "deinit"]);
const CLASS_AS_MODIFIER_NEXT = new Set(["func", "var", "let", "subscript", "init", "static", "final", "override", "public", "private", "open", "internal", "fileprivate"]);
const KEYWORDS = new Set([
  "let", "var", "func", "if", "else", "guard", "return", "true", "false", "nil", "self", "Self", "super", "init", "struct", "class",
  "enum", "extension", "protocol", "actor", "case", "switch", "default", "for", "in", "while", "repeat", "do", "try", "catch", "throw",
  "throws", "async", "await", "import", "static", "some", "any", "where", "as", "is", "break", "continue", "defer", "typealias",
]);
const SELF_WORDS = new Set(["self"]);

/** SwiftUI initializers whose first unlabeled string argument is a LocalizedStringKey. */
const LOCALIZED_UI = new Set(["Text", "Button", "Label", "Toggle", "Link", "navigationTitle", "LocalizedStringKey", "LocalizedStringResource", "NSLocalizedString", "Section", "Picker", "TextField", "Menu"]);

interface Ctx {
  path: string[];
  depth: number;
  parentId?: string;
  inEnum: boolean;
  stringEnum: boolean;
}

export function parseSwift(file: SourceFile, text: string, generated: boolean): ClikeParsed {
  const { tokens, comments, match } = lex(text, "swift");
  const decls: TokenDecl[] = [];
  const imports: string[] = [];
  const screens: { name: string; symbolId: string }[] = [];
  const symbolPrefix = `symbol:${file.scope}/`;

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
      if (kw === "class" && CLASS_AS_MODIFIER_NEXT.has(tokens[i + 1]?.v ?? "")) {
        i++;
        continue;
      }
      if (kw === "import" && ctx.depth === 0) {
        let j = i + 1;
        if (isId(tokens[j]) && ["struct", "class", "enum", "protocol", "typealias", "func", "let", "var"].includes(tokens[j]!.v) && isId(tokens[j + 1])) j++;
        if (isId(tokens[j])) imports.push(tokens[j]!.v);
        i = scanEnd(tokens, match, i, to, continuesSwiftKotlin) + 1;
        lower = i;
        continue;
      }
      const isType = TYPE_KW.has(kw) && isId(tokens[i + 1]);
      const isMember = MEMBER_KW.has(kw) || (kw === "case" && ctx.inEnum);
      if (!isType && !isMember) {
        i++;
        continue;
      }
      if (isP(tokens[i - 1], ".")) {
        i++;
        continue;
      }
      const start = declStart(tokens, match, i, lower, MODIFIERS);
      const end = scanEnd(tokens, match, i, to, continuesSwiftKotlin);
      const isStatic = tokens.slice(start, i).some((t) => t.k === "id" && (t.v === "static" || t.v === "class"));
      if (isType) parseType(i, start, end, kw, ctx);
      else if (kw === "case") parseCases(i, end, ctx);
      else parseMember(i, start, end, kw, ctx, isStatic);
      i = end + 1;
      lower = i;
    }
  };

  const parseType = (k: number, start: number, end: number, kw: string, ctx: Ctx) => {
    let j = k + 1;
    const nameParts = [tokens[j]!.v];
    while (isP(tokens[j + 1], ".") && isId(tokens[j + 2])) {
      nameParts.push(tokens[j + 2]!.v);
      j += 2;
    }
    const body = findBody(tokens, match, j + 1, end);
    const headerEnd = body >= 0 ? body - 1 : end;
    const inherits = inheritance(tokens, match, j + 1, headerEnd);
    const qparts = kw === "extension" ? nameParts : [...ctx.path, ...nameParts];
    const qname = qparts.join(".");
    const id = symbolPrefix + qname;
    if (kw !== "extension") {
      const decl = addDecl(decls, {
        decl: {
          id,
          name: nameParts[nameParts.length - 1]!,
          qname,
          kind: kw,
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
      if (decl && kw === "struct" && ctx.depth === 0 && inherits.some((n) => n === "View" || n === "SwiftUI.View")) {
        const screen = nameParts[0]!.replace(/(View|Screen)$/, "");
        if (screen.length > 0) screens.push({ name: screen, symbolId: id });
      }
    }
    if (body >= 0 && match[body]! > body) {
      walk(body + 1, match[body]!, {
        path: qparts,
        depth: ctx.depth + 1,
        parentId: id,
        inEnum: kw === "enum",
        stringEnum: kw === "enum" && inherits[0] === "String",
      });
    }
  };

  const parseMember = (k: number, start: number, end: number, kw: string, ctx: Ctx, isStatic: boolean) => {
    let name: string | undefined;
    let nameIdx = k;
    if (kw === "init" || kw === "deinit" || kw === "subscript") name = kw;
    else if (isId(tokens[k + 1])) {
      name = tokens[k + 1]!.v;
      nameIdx = k + 1;
    }
    if (!name) return;
    const qname = [...ctx.path, name].join(".");
    let value;
    if (kw === "let") {
      const eq = findAssign(tokens, match, nameIdx + 1, end);
      if (eq >= 0) value = parseLiteralRange(tokens, match, eq + 1, end, "swift");
    }
    addDecl(decls, {
      decl: {
        id: symbolPrefix + qname,
        name,
        qname,
        kind: kw,
        line: tokens[start]!.line,
        endLine: tokens[end]!.endLine,
        depth: ctx.depth,
        parent: ctx.parentId,
        hash: hashTokens(tokens, start, end),
        value,
        isStatic: isStatic || undefined,
      },
      from: start,
      to: end,
      owner: ctx.path.length ? ctx.path.join(".") : undefined,
    });
  };

  const parseCases = (k: number, end: number, ctx: Ctx) => {
    for (const [s, e] of splitTopLevel(tokens, match, k + 1, end)) {
      const nameTok = tokens[s];
      if (!isId(nameTok)) continue;
      const name = nameTok!.v;
      const qname = [...ctx.path, name].join(".");
      let value;
      const eq = findAssign(tokens, match, s + 1, e);
      if (eq >= 0) value = parseLiteralRange(tokens, match, eq + 1, e, "swift");
      else if (ctx.stringEnum && s === e) value = name;
      addDecl(decls, {
        decl: {
          id: symbolPrefix + qname,
          name,
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
    }
  };

  walk(0, tokens.length, { path: [], depth: 0, inEnum: false, stringEnum: false });

  const paint = paintOwners(tokens.length, decls);
  const refs = collectNameRefs(tokens, decls, paint, KEYWORDS, SELF_WORDS);
  const { signals, i18nRefs } = scanSignals(tokens, decls, paint, {
    env: (i) => {
      const tk = tokens[i]!;
      if (tk.v === "environment" && isP(tokens[i - 1], ".") && isP(tokens[i + 1], "[") && tokens[i + 2]?.k === "str" && isP(tokens[i + 3], "]")) return tokens[i + 2]!.s;
      if (tk.v === "getenv" && isP(tokens[i + 1], "(")) return firstStringArg(tokens, i + 1);
      return undefined;
    },
    i18n: (i) => swiftI18n(tokens, i),
  });

  return {
    file,
    lang: "swift",
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

function swiftI18n(tokens: Token[], i: number): string | undefined {
  const tk = tokens[i]!;
  const open = tokens[i + 1];
  if (!isP(open, "(")) return undefined;
  if (tk.v === "String") {
    return isId(tokens[i + 2], "localized") && isP(tokens[i + 3], ":") ? firstStringArg(tokens, i + 1) : undefined;
  }
  if (!LOCALIZED_UI.has(tk.v)) return undefined;
  const arg = tokens[i + 2];
  if (arg?.k !== "str" || arg.s === undefined) return undefined;
  return isP(tokens[i + 3], ")") || isP(tokens[i + 3], ",") ? arg.s : undefined;
}

/** Names in an inheritance clause: `: View, Identifiable where ...`. */
function inheritance(tokens: Token[], match: Int32Array, from: number, to: number): string[] {
  let j = from;
  while (j <= to && !isP(tokens[j], ":")) {
    if (isP(tokens[j], "(") || isP(tokens[j], "[")) j = Math.max(j, match[j]!);
    j++;
  }
  if (j > to) return [];
  const names: string[] = [];
  let current = "";
  for (j = j + 1; j <= to; j++) {
    const tk = tokens[j]!;
    if (isId(tk, "where")) break;
    if (isP(tk, "<") || isP(tk, "(")) {
      // skip generic arguments / parenthesised constraints
      let depth = 0;
      for (; j <= to; j++) {
        const t2 = tokens[j]!;
        if (t2.k === "p" && (t2.v === "<" || t2.v === "(")) depth++;
        else if (t2.k === "p" && (t2.v === ">" || t2.v === ")")) depth--;
        else if (t2.k === "p" && t2.v.startsWith(">")) depth -= t2.v.length;
        if (depth <= 0) break;
      }
      continue;
    }
    if (isP(tk, ",")) {
      if (current) names.push(current);
      current = "";
      continue;
    }
    if (tk.k === "id") current += tk.v;
    else if (isP(tk, ".")) current += ".";
  }
  if (current) names.push(current);
  return names;
}
