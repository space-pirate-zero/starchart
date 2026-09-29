import type { Graph } from "../core/graph.js";
import type { GraphNode } from "../core/model.js";

/** Values too common to mean anything when found in text. */
export const GENERIC_VALUES: ReadonlySet<string> = new Set([
  "active", "inactive", "enabled", "disabled", "draft", "live", "test", "prod", "production", "staging", "archived", "retired",
  "deprecated", "pending", "default", "none", "null", "true", "false", "yes", "off", "free", "paid", "basic", "standard", "plus",
  "monthly", "yearly", "annual", "annually", "weekly", "daily", "month", "year", "week", "day", "usd", "eur", "gbp",
  "name", "title", "description", "price", "value", "type", "status", "new", "all", "app", "web", "ios", "android",
]);

/** Fact nodes with a value that are not containers (no other fact is `partOf` them). */
export function leafFacts(graph: Graph): GraphNode[] {
  return graph.nodes({ kind: "fact" }).filter((f) => f.value !== undefined && !graph.incoming(f.id, "partOf").some((e) => graph.node(e.from)?.kind === "fact"));
}

/** The text searched for a leaf fact, or undefined when its value is too generic to scan for. */
export function searchText(fact: GraphNode): string | undefined {
  if (fact.id.endsWith(".status")) return undefined;
  const v = fact.value;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.length < 3 || s !== v || s.includes("\n")) return undefined;
    if (GENERIC_VALUES.has(s.toLowerCase())) return undefined;
    return s;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const s = String(v);
    // integers are only distinctive when long (1999, 2026); decimals always are (4.99)
    if (Number.isInteger(v) && s.replace("-", "").length < 4) return undefined;
    return s;
  }
  return undefined;
}

const WORD = /[\p{L}\p{N}_]/u;
const DIGIT = /[0-9]/;

function isWord(c: string | undefined): boolean {
  return c !== undefined && WORD.test(c);
}

/** Whole-token matching of many literal needles at once. */
export class LiteralMatcher {
  private readonly regex: RegExp | undefined;

  constructor(needles: Iterable<string>) {
    const list = [...new Set(needles)].filter((n) => n.length > 0).sort((a, b) => b.length - a.length);
    this.regex = list.length ? new RegExp(list.map(escapeRegex).join("|"), "gu") : undefined;
  }

  /** Every whole-token occurrence in `text`: not inside a longer identifier or number. */
  *matches(text: string): Generator<{ index: number; needle: string }> {
    if (!this.regex) return;
    const re = new RegExp(this.regex.source, this.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const needle = m[0];
      const start = m.index;
      const end = start + needle.length;
      if (isBoundary(text, start, end, needle)) {
        yield { index: start, needle };
        re.lastIndex = end;
      } else {
        re.lastIndex = start + 1;
      }
    }
  }

  /** Whether `needle` occurs as a whole token in `text`. */
  static containsToken(text: string, needle: string): boolean {
    let from = 0;
    for (;;) {
      const i = text.indexOf(needle, from);
      if (i < 0) return false;
      if (isBoundary(text, i, i + needle.length, needle)) return true;
      from = i + 1;
    }
  }
}

function isBoundary(text: string, start: number, end: number, needle: string): boolean {
  const first = needle[0]!;
  const last = needle[needle.length - 1]!;
  const before = text[start - 1];
  const after = text[end];
  if (isWord(first) && isWord(before)) return false;
  if (isWord(last) && isWord(after)) return false;
  // numbers: "4.99" must not match inside "14.99", "1.4.99" or "4.995" / "4.99.1"
  if (DIGIT.test(first) && before === "." && DIGIT.test(text[start - 2] ?? "")) return false;
  if (DIGIT.test(last) && after === "." && DIGIT.test(text[end + 1] ?? "")) return false;
  return true;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A fact plus every fact above (containers) and below (leaves) it along `partOf`. */
export function relatedFacts(graph: Graph, factId: string): Set<string> {
  const out = new Set<string>([factId]);
  const up = [factId];
  while (up.length) {
    const id = up.pop()!;
    for (const e of graph.outgoing(id, "partOf")) {
      if (!out.has(e.to) && graph.node(e.to)?.kind === "fact") {
        out.add(e.to);
        up.push(e.to);
      }
    }
  }
  const down = [factId];
  while (down.length) {
    const id = down.pop()!;
    for (const e of graph.incoming(id, "partOf")) {
      if (!out.has(e.from) && graph.node(e.from)?.kind === "fact") {
        out.add(e.from);
        down.push(e.from);
      }
    }
  }
  return out;
}

/** Root-relative posix form of an fs binding path. */
export function normalizeBindingPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}
