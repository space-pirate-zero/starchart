import { createHash } from "node:crypto";
import { sep } from "node:path";
import { stableStringify } from "../core/lock.js";

/** sha1 hex, truncated to 16 chars: the content hash used by every code node. */
export function sha16(data: string | Uint8Array): string {
  return createHash("sha1").update(data).digest("hex").slice(0, 16);
}

/** Collapses every whitespace run so hashes survive reformatting and line shifts. */
export function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function hashText(text: string): string {
  return sha16(normalizeWs(text));
}

export function hashJson(value: unknown): string {
  return sha16(stableStringify(value));
}

export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/** Joins posix path segments, dropping "." and empty segments. */
export function joinPosix(...parts: string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    for (const seg of part.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push(seg);
    }
  }
  return out.join("/");
}

export function dirnamePosix(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function basenamePosix(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** Offsets at which each line starts (line 1 is index 0). */
export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 1-based line number of an offset. */
export function lineAt(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** "en", "en-US", "pt_BR", "zh-Hans", "sr-Latn-RS". */
export function isLocaleCode(name: string): boolean {
  return /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(name);
}

export function pushMulti<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Runs `fn` over `items` with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Splits camelCase, PascalCase, snake_case, kebab-case and dotted names into lowercase tokens. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

/** A literal value extracted from source: string, number, boolean, or arrays/objects of those. */
export type LiteralValue = string | number | boolean | LiteralValue[] | { [key: string]: LiteralValue };
