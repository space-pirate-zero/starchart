import type { LiteralValue } from "./util.js";

export type SourceLang = "ts" | "swift" | "kotlin" | "go" | "mdx" | "text";

/** A file assigned to one code scope. All paths are posix. */
export interface SourceFile {
  scope: string;
  /** Scope directory relative to the project root ("" for the root itself). */
  scopeDir: string;
  /** Path relative to the scope directory. */
  rel: string;
  /** Path relative to the project root. */
  path: string;
  abs: string;
  lang: SourceLang;
  isTest: boolean;
}

export interface SymbolDecl {
  id: string;
  /** Short name, used as the node label. */
  name: string;
  /** Name inside its namespace: "Pricing.proUSD", "PRICING.pro", "Server.Handle". */
  qname: string;
  kind: string;
  line: number;
  endLine: number;
  /** Nesting depth; 0 = top level. */
  depth: number;
  /** Owning symbol id for members. */
  parent?: string;
  hash: string;
  value?: LiteralValue;
  exported?: boolean;
  isType?: boolean;
  isStatic?: boolean;
  /** Extra line ranges when one id covers several declarations (overloads). */
  ranges?: [number, number][];
}

export interface Signal {
  kind: "env" | "flag" | "event";
  name: string;
  /** Innermost symbol containing the call; undefined = file level. */
  from?: string;
  line: number;
}

export interface I18nRef {
  key: string;
  from?: string;
  line: number;
}

/** A comment carrying one or more `@starchart` annotations. */
export interface AnnotationComment {
  text: string;
  line: number;
  endLine: number;
  /** Code precedes the comment on its first line. */
  trailing: boolean;
}

export interface ScreenDecl {
  name: string;
  symbolId: string;
}

/**
 * A reference chain found in Swift/Kotlin/Go source: `Pricing.proUSD` -> ["Pricing", "proUSD"].
 * `leadingDot` marks Swift implicit member syntax (`.proMonthly`).
 */
export interface NameRef {
  from?: string;
  chain: string[];
  leadingDot?: boolean;
  /** Qualified name of the innermost enclosing type (for bare member and `self.x` references). */
  owner?: string;
  line: number;
}

/** Common result of parsing one source file. */
export interface ParsedFile {
  file: SourceFile;
  lang: "ts" | "swift" | "kotlin" | "go";
  hash: string;
  generated: boolean;
  symbols: SymbolDecl[];
  signals: Signal[];
  i18nRefs: I18nRef[];
  annotations: AnnotationComment[];
  /** 1-based line numbers holding code (not blank, not comment-only). */
  codeLines: Set<number>;
  screens: ScreenDecl[];
}

export interface Diagnostics {
  warn(message: string): void;
}
