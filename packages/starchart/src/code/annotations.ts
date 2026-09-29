import type { AnnotationComment, SymbolDecl } from "./types.js";

/** One `@starchart <verb> <targets...>` directive. */
export interface AnnotationEntry {
  verb: string;
  targets: string[];
  line: number;
}

/** Verbs that are markers rather than edges. */
export const MARKER_VERBS: ReadonlySet<string> = new Set(["generated", "id", "ignore"]);

const TARGET_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:/@#\-[\]+~*$]*$/;

/** Parses every directive in a comment. */
export function parseAnnotations(comment: AnnotationComment): AnnotationEntry[] {
  const out: AnnotationEntry[] = [];
  const lines = comment.text.split("\n");
  lines.forEach((raw, offset) => {
    for (const m of raw.matchAll(/@starchart\s+([A-Za-z][A-Za-z0-9_-]*)(.*?)(?=@starchart\b|$)/g)) {
      const verb = m[1]!;
      const rest = (m[2] ?? "").replace(/\*\/.*$/, "").replace(/-->.*$/, "").replace(/\*\/\s*\}\s*$/, "");
      const tokens = rest.split(/[\s,]+/).map((t) => t.replace(/[.;]+$/, "")).filter((t) => t.length > 0);
      const targets: string[] = [];
      if (verb === "screen") {
        const name = tokens[0];
        if (name && TARGET_RE.test(name)) targets.push(name);
      } else {
        for (const t of tokens) {
          // node ids carry a colon (addon:pro.name) or a dot (tokens.color.brand); prose words have neither
          if ((!t.includes(":") && !t.includes(".")) || !TARGET_RE.test(t)) break;
          targets.push(t);
        }
      }
      out.push({ verb, targets, line: comment.line + offset });
    }
  });
  return out;
}

/** Finds `@starchart` directives in files we do not parse (markdown, html, yaml, css, ...). */
export function scanTextAnnotations(text: string): AnnotationComment[] {
  if (!text.includes("@starchart")) return [];
  const out: AnnotationComment[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!line.includes("@starchart")) return;
    if (!/(?:\/\/|#|\/\*|<!--|\{\/\*|--|;)\s*@starchart\b/.test(line) && !/^\s*\*\s*@starchart\b/.test(line)) return;
    out.push({ text: line, line: i + 1, endLine: i + 1, trailing: false });
  });
  return out;
}

/**
 * Decides which node a comment annotates:
 * 1. a trailing comment annotates the declaration starting on its line;
 * 2. otherwise the next declaration, if only blank/comment lines separate them;
 * 3. otherwise the innermost declaration containing the comment;
 * 4. otherwise the file.
 */
export function annotationTarget(comment: AnnotationComment, symbols: SymbolDecl[], codeLines: Set<number>, fileId: string): string {
  if (comment.trailing) {
    const sameLine = symbols.filter((s) => s.line === comment.line).sort((a, b) => b.depth - a.depth);
    if (sameLine[0]) return sameLine[0].id;
  } else {
    let next: SymbolDecl | undefined;
    for (const s of symbols) {
      if (s.line <= comment.endLine) continue;
      if (!next || s.line < next.line || (s.line === next.line && s.depth < next.depth)) next = s;
    }
    if (next) {
      let clear = true;
      for (let l = comment.endLine + 1; l < next.line; l++) {
        if (codeLines.has(l)) {
          clear = false;
          break;
        }
      }
      if (clear) return next.id;
    }
  }
  let inner: SymbolDecl | undefined;
  for (const s of symbols) {
    if (s.line <= comment.line && comment.line <= s.endLine && (!inner || s.depth > inner.depth)) inner = s;
  }
  return inner?.id ?? fileId;
}
