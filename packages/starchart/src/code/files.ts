import fg from "fast-glob";
import { resolve } from "node:path";
import type { CodeConfig } from "../config/schema.js";
import type { SourceFile, SourceLang } from "./types.js";
import { basenamePosix, joinPosix, toPosix } from "./util.js";

/** Directories never scanned, whatever the config says. */
export const ALWAYS_EXCLUDED_DIRS = ["node_modules", "dist", "build", ".git", ".next", "DerivedData", "Pods", ".starchart"];

export interface ScopeDef {
  name: string;
  /** Root-relative posix directory; "" for the root. */
  dir: string;
}

export function scopeDefs(config: CodeConfig): ScopeDef[] {
  const scopes = Object.keys(config.scopes ?? {}).length ? config.scopes : { app: "." };
  return Object.entries(scopes)
    .map(([name, dir]) => ({ name, dir: joinPosix(toPosix(dir)) }))
    .sort((a, b) => b.dir.length - a.dir.length || a.name.localeCompare(b.name));
}

/** The most specific scope containing a root-relative path. */
export function scopeForPath(scopes: ScopeDef[], path: string): { scope: ScopeDef; rel: string } | undefined {
  for (const scope of scopes) {
    if (scope.dir === "") return { scope, rel: path };
    if (path === scope.dir || path.startsWith(`${scope.dir}/`)) return { scope, rel: path.slice(scope.dir.length + 1) };
  }
  return undefined;
}

export type FileRole = "code" | "mdx" | "manifest" | "i18n" | "tsconfig" | "text";

const TS_CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TEXT_EXT = /\.(?:md|html?|ya?ml|css|scss|sass|less|xml|toml|vue|svelte|astro|sql|graphql|gql|py|rb|sh|txt|plist|properties|gradle)$/;
const MANIFESTS = new Set(["package.json", "Package.resolved", "Package.swift", "build.gradle", "build.gradle.kts", "libs.versions.toml", "go.mod", "project.pbxproj"]);
const I18N_JSON_DIRS = new Set(["locales", "locale", "i18n", "messages", "lang", "translations"]);

export interface Classified {
  role: FileRole;
  lang: SourceLang;
}

/** Decides how a scope-relative path is processed, or undefined to ignore it. */
export function classify(rel: string): Classified | undefined {
  const base = basenamePosix(rel);
  if (MANIFESTS.has(base)) return { role: "manifest", lang: "text" };
  if (base === "tsconfig.json" || base === "jsconfig.json") return { role: "tsconfig", lang: "text" };
  if (base.endsWith(".xcstrings")) return { role: "i18n", lang: "text" };
  if (base.endsWith(".strings") && rel.includes(".lproj/")) return { role: "i18n", lang: "text" };
  if (base === "strings.xml" && /(?:^|\/)res\/values[^/]*\/strings\.xml$/.test(rel)) return { role: "i18n", lang: "text" };
  if (base.endsWith(".json")) {
    const segs = rel.split("/").slice(0, -1);
    return segs.some((s) => I18N_JSON_DIRS.has(s)) ? { role: "i18n", lang: "text" } : undefined;
  }
  if (TS_CODE.test(base)) {
    if (base.endsWith(".d.ts") || base.endsWith(".d.mts") || base.endsWith(".d.cts") || /\.min\.js$/.test(base)) return undefined;
    return { role: "code", lang: "ts" };
  }
  if (base.endsWith(".swift")) return { role: "code", lang: "swift" };
  if (base.endsWith(".kt")) return { role: "code", lang: "kotlin" };
  if (base.endsWith(".go")) return { role: "code", lang: "go" };
  if (base.endsWith(".mdx")) return { role: "mdx", lang: "mdx" };
  if (TEXT_EXT.test(base)) return { role: "text", lang: "text" };
  return undefined;
}

/** Test files: *.test.ts(x), *.spec.ts(x), __tests__/*, *Tests.swift, *Test.kt, *_test.go, and platform test dirs. */
export function isTestPath(rel: string, lang: SourceLang): boolean {
  const base = basenamePosix(rel);
  const segs = rel.split("/").slice(0, -1);
  switch (lang) {
    case "ts":
      return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base) || segs.includes("__tests__");
    case "swift":
      return /Tests?\.swift$/.test(base) || segs.some((s) => /Tests$/.test(s));
    case "kotlin":
      return /Tests?\.kt$/.test(base) || /(?:^|\/)src\/(?:test|androidTest|testDebug|testRelease)\//.test(rel);
    case "go":
      return base.endsWith("_test.go");
    default:
      return false;
  }
}

export interface DiscoveredFile extends SourceFile {
  role: FileRole;
}

function ignorePatterns(scope: ScopeDef, config: CodeConfig): string[] {
  const out = ALWAYS_EXCLUDED_DIRS.map((d) => `**/${d}/**`);
  for (const pattern of config.exclude ?? []) {
    const p = toPosix(pattern).replace(/^\.\//, "");
    out.push(p);
    if (scope.dir && p.startsWith(`${scope.dir}/`)) out.push(p.slice(scope.dir.length + 1));
  }
  return out;
}

function includePatterns(scope: ScopeDef, config: CodeConfig): string[] {
  if (!config.include?.length) return ["**/*"];
  const out: string[] = [];
  for (const pattern of config.include) {
    const p = toPosix(pattern).replace(/^\.\//, "");
    out.push(scope.dir && p.startsWith(`${scope.dir}/`) ? p.slice(scope.dir.length + 1) : p);
  }
  return out;
}

/**
 * Lists every relevant file of every scope. Nested scopes win over their parents, so each
 * file belongs to exactly one scope. Include/exclude globs are matched relative to each
 * scope directory; root-relative patterns that start with the scope directory also work.
 */
export async function discoverFiles(root: string, config: CodeConfig): Promise<DiscoveredFile[]> {
  const scopes = scopeDefs(config);
  const assigned = new Set<string>();
  const out: DiscoveredFile[] = [];
  for (const scope of scopes) {
    const cwd = resolve(root, scope.dir || ".");
    const entries = await fg(includePatterns(scope, config), {
      cwd,
      ignore: ignorePatterns(scope, config),
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      unique: true,
    });
    entries.sort();
    for (const rel of entries) {
      const path = joinPosix(scope.dir, rel);
      if (assigned.has(path)) continue;
      const cls = classify(rel);
      if (!cls) continue;
      assigned.add(path);
      out.push({
        scope: scope.name,
        scopeDir: scope.dir,
        rel,
        path,
        abs: resolve(root, path),
        lang: cls.lang,
        role: cls.role,
        isTest: cls.role === "code" && isTestPath(rel, cls.lang),
      });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Whether the first five lines mark the file as STARCHART codegen output. */
export function isGeneratedText(text: string): boolean {
  let end = 0;
  for (let n = 0; n < 5; n++) {
    const next = text.indexOf("\n", end);
    if (next < 0) {
      end = text.length;
      break;
    }
    end = next + 1;
  }
  return text.slice(0, end).includes("@starchart generated");
}
