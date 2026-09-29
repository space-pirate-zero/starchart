import type { Diagnostics } from "./types.js";
import { basenamePosix, computeLineStarts, isLocaleCode, lineAt } from "./util.js";

/** One localized string definition found in a resource file. */
export interface I18nEntry {
  key: string;
  locale: string;
  value: string;
  line: number;
}

/**
 * Extracts localized strings from Apple .xcstrings / .strings, Android strings.xml and
 * JSON message catalogs. `rel` is the scope-relative path (used to infer locales).
 */
export function parseI18nFile(rel: string, text: string, diag: Diagnostics, path: string): I18nEntry[] {
  const base = basenamePosix(rel);
  try {
    if (base.endsWith(".xcstrings")) return parseXcstrings(text);
    if (base.endsWith(".strings")) return parseDotStrings(text, lprojLocale(rel));
    if (base === "strings.xml") return parseAndroidStrings(text, androidLocale(rel));
    if (base.endsWith(".json")) return parseJsonCatalog(rel, text);
  } catch (err) {
    diag.warn(`${path}: could not parse localization file (${(err as Error).message})`);
  }
  return [];
}

function lprojLocale(rel: string): string {
  const m = /(?:^|\/)([^/]+)\.lproj\//.exec(rel);
  return m ? m[1]! : "base";
}

function androidLocale(rel: string): string {
  const m = /(?:^|\/)values(?:-([^/]+))?\/strings\.xml$/.exec(rel);
  const q = m?.[1];
  if (!q) return "default";
  const bcp = /^b\+(.+)$/.exec(q);
  if (bcp) return bcp[1]!.replace(/\+/g, "-");
  return q.replace(/-r([A-Z]{2})$/, "-$1");
}

function parseXcstrings(text: string): I18nEntry[] {
  const json = JSON.parse(text) as { sourceLanguage?: string; strings?: Record<string, unknown> };
  const lines = jsonKeyLines(text);
  const source = json.sourceLanguage ?? "en";
  const out: I18nEntry[] = [];
  for (const [key, raw] of Object.entries(json.strings ?? {})) {
    const line = lines.get(pathKey(["strings", key])) ?? 1;
    const locs = (raw as { localizations?: Record<string, unknown> } | null)?.localizations ?? {};
    let hasSource = false;
    for (const [locale, loc] of Object.entries(locs)) {
      const value = xcstringsValue(loc);
      if (value === undefined) continue;
      if (locale === source) hasSource = true;
      out.push({ key, locale, value, line });
    }
    if (!hasSource) out.push({ key, locale: source, value: key, line });
  }
  return out;
}

function xcstringsValue(loc: unknown): string | undefined {
  if (!loc || typeof loc !== "object") return undefined;
  const l = loc as { stringUnit?: { value?: unknown }; variations?: Record<string, Record<string, unknown>> };
  if (typeof l.stringUnit?.value === "string") return l.stringUnit.value;
  for (const group of Object.values(l.variations ?? {})) {
    const variants = group ?? {};
    const preferred = variants.other ?? Object.values(variants)[0];
    const v = xcstringsValue(preferred);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Old-style `"key" = "value";` strings files, with comments. */
function parseDotStrings(text: string, locale: string): I18nEntry[] {
  const starts = computeLineStarts(text);
  const out: I18nEntry[] = [];
  let i = 0;
  const n = text.length;
  const skip = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i]!)) i++;
      if (text.startsWith("//", i)) {
        const e = text.indexOf("\n", i);
        i = e < 0 ? n : e;
      } else if (text.startsWith("/*", i)) {
        const e = text.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
      } else return;
    }
  };
  const readString = (): string | undefined => {
    if (text[i] === '"') {
      let s = "";
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < n) {
          const c = text[i + 1]!;
          s += c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c;
          i += 2;
        } else s += text[i++];
      }
      i++;
      return s;
    }
    const m = /^[A-Za-z0-9_.$-]+/.exec(text.slice(i, i + 256));
    if (!m) return undefined;
    i += m[0].length;
    return m[0];
  };
  while (i < n) {
    skip();
    if (i >= n) break;
    const at = i;
    const key = readString();
    if (key === undefined) {
      i++;
      continue;
    }
    skip();
    if (text[i] !== "=") {
      if (text[i] === ";") i++;
      continue;
    }
    i++;
    skip();
    const value = readString();
    skip();
    if (text[i] === ";") i++;
    if (value !== undefined) out.push({ key, locale, value, line: lineAt(starts, at) });
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseAndroidStrings(text: string, locale: string): I18nEntry[] {
  const starts = computeLineStarts(text);
  const out: I18nEntry[] = [];
  const noComments = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  for (const m of noComments.matchAll(/<string\b([^>]*?)(?:\/>|>([\s\S]*?)<\/string>)/g)) {
    const name = /\bname\s*=\s*"([^"]+)"/.exec(m[1]!)?.[1];
    if (!name) continue;
    let value = decodeXml(m[2] ?? "").trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    value = value.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(['"@?\\])/g, "$1");
    out.push({ key: name, locale, value, line: lineAt(starts, m.index ?? 0) });
  }
  return out;
}

function parseJsonCatalog(rel: string, text: string): I18nEntry[] {
  const json = JSON.parse(text) as unknown;
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const segs = rel.split("/");
  const stem = segs[segs.length - 1]!.replace(/\.json$/, "");
  const parent = segs[segs.length - 2] ?? "";
  const locale = isLocaleCode(stem) ? stem : isLocaleCode(parent) ? parent : stem;
  const lines = jsonKeyLines(text);
  const out: I18nEntry[] = [];
  const walk = (value: unknown, path: string[]) => {
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, [...path, k]);
      return;
    }
    if (path.length === 0 || value === null || value === undefined) return;
    out.push({ key: path.join("."), locale, value: String(value), line: lines.get(pathKey(path)) ?? 1 });
  };
  walk(json, []);
  return out;
}

const pathKey = (segments: string[]) => segments.join("\u0000");

/**
 * Line number of every object key in a JSON document, keyed by its path
 * (segments joined with NUL; array elements use their index).
 */
export function jsonKeyLines(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const stack: { type: "obj" | "arr"; index: number; key?: string }[] = [];
  const path: string[] = [];
  let line = 1;
  let i = 0;
  let pendingKey: string | undefined;
  const n = text.length;
  const readString = (): string => {
    let s = "";
    i++;
    while (i < n && text[i] !== '"') {
      if (text[i] === "\\") {
        const c = text[i + 1];
        if (c === "u") {
          s += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        s += c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c === "b" ? "\b" : c === "f" ? "\f" : (c ?? "");
        i += 2;
        continue;
      }
      if (text[i] === "\n") line++;
      s += text[i++];
    }
    i++;
    return s;
  };
  const segmentForValue = (): string | undefined => {
    const top = stack[stack.length - 1];
    if (!top) return undefined;
    if (top.type === "arr") return String(top.index);
    return pendingKey;
  };
  while (i < n) {
    const c = text[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === '"') {
      const startLine = line;
      const s = readString();
      const top = stack[stack.length - 1];
      let j = i;
      while (j < n && /\s/.test(text[j]!)) j++;
      if (top?.type === "obj" && text[j] === ":") {
        pendingKey = s;
        out.set(pathKey([...path, s]), startLine);
      }
      continue;
    }
    if (c === "{" || c === "[") {
      const seg = segmentForValue();
      if (seg !== undefined) path.push(seg);
      stack.push({ type: c === "{" ? "obj" : "arr", index: 0, key: seg });
      pendingKey = undefined;
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      const top = stack.pop();
      if (top?.key !== undefined) path.pop();
      i++;
      continue;
    }
    if (c === ",") {
      const top = stack[stack.length - 1];
      if (top?.type === "arr") top.index++;
      i++;
      continue;
    }
    i++;
  }
  return out;
}
