import { firstStringArg, isP, type TokenDecl } from "./clike.js";
import type { Token } from "./lexer.js";
import { EVENT_FUNCS, FLAG_FUNCS, isEnvName, isSignalKey } from "./signals.js";
import type { I18nRef, NameRef, ParsedFile, Signal } from "./types.js";
import { sha16 } from "./util.js";

/** Parse result for Swift, Kotlin and Go sources. */
export interface ClikeParsed extends ParsedFile {
  lang: "swift" | "kotlin" | "go";
  refs: NameRef[];
  /** Swift module names, Kotlin import paths, Go import paths. */
  imports: string[];
  go?: GoPackageInfo;
}

export interface GoPackageInfo {
  /** Package name from the `package` clause. */
  name: string;
  /** Namespace used in symbol ids: the package directory relative to the scope, or the package name at the scope root. */
  namespace: string;
  /** Package directory relative to the project root. */
  dir: string;
  /** Local import name -> import path. */
  aliases: Record<string, string>;
}

const indexes = new WeakMap<TokenDecl[], Map<string, TokenDecl>>();

/**
 * Adds a declaration span. A second declaration with the same id (an overload) shares the
 * first one's symbol: its range is recorded and the hash covers both. Returns the span when
 * it introduced a new symbol, undefined when it merged into an existing one.
 */
export function addDecl(decls: TokenDecl[], d: TokenDecl): TokenDecl | undefined {
  let index = indexes.get(decls);
  if (!index) {
    index = new Map();
    indexes.set(decls, index);
  }
  const existing = index.get(d.decl.id);
  if (!existing) {
    index.set(d.decl.id, d);
    decls.push(d);
    return d;
  }
  const sym = existing.decl;
  sym.ranges = [...(sym.ranges ?? [[sym.line, sym.endLine]]), [d.decl.line, d.decl.endLine]];
  sym.hash = sha16(sym.hash + d.decl.hash);
  if (sym.value !== undefined && JSON.stringify(sym.value) !== JSON.stringify(d.decl.value)) delete sym.value;
  decls.push({ ...d, decl: sym });
  return undefined;
}

/** Unique symbols of a span list, in declaration order. */
export function uniqueSymbols(decls: TokenDecl[]) {
  const seen = new Set<string>();
  const out = [];
  for (const d of decls) {
    if (seen.has(d.decl.id)) continue;
    seen.add(d.decl.id);
    out.push(d.decl);
  }
  return out;
}

export interface SignalHooks {
  /** Env var name read at token i, if any. */
  env(i: number): string | undefined;
  /** Localization key referenced at token i, if any. */
  i18n(i: number): string | undefined;
}

/** Finds flag reads, event emissions, env reads and localization references by token pattern. */
export function scanSignals(tokens: Token[], decls: TokenDecl[], paint: Int32Array, hooks: SignalHooks): { signals: Signal[]; i18nRefs: I18nRef[] } {
  const signals: Signal[] = [];
  const i18nRefs: I18nRef[] = [];
  const fromAt = (i: number) => {
    const di = paint[i]!;
    return di >= 0 ? decls[di]!.decl.id : undefined;
  };
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]!;
    if (tk.k !== "id") continue;
    if (isP(tokens[i + 1], "(")) {
      if (FLAG_FUNCS.has(tk.v)) {
        const key = firstStringArg(tokens, i + 1);
        if (key !== undefined && isSignalKey(key)) signals.push({ kind: "flag", name: key, from: fromAt(i), line: tk.line });
      } else if (EVENT_FUNCS.has(tk.v)) {
        const name = firstStringArg(tokens, i + 1);
        if (name !== undefined && isSignalKey(name)) signals.push({ kind: "event", name, from: fromAt(i), line: tk.line });
      }
    }
    const env = hooks.env(i);
    if (env !== undefined && isEnvName(env)) signals.push({ kind: "env", name: env, from: fromAt(i), line: tk.line });
    const key = hooks.i18n(i);
    if (key !== undefined && key.length > 0) i18nRefs.push({ key, from: fromAt(i), line: tk.line });
  }
  return { signals, i18nRefs };
}
