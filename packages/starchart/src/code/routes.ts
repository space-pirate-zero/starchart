import type { SourceFile } from "./types.js";
import { basenamePosix, dirnamePosix, joinPosix } from "./util.js";

export interface RouteInfo {
  id: string;
  /** URL path without the leading slash ("" for the root). */
  url: string;
  api: boolean;
  router: "app" | "pages";
}

const NEXT_CONFIG = /^next\.config\.(?:js|mjs|cjs|ts|mts)$/;
const APP_PAGE = /^page\.(?:tsx|jsx|ts|js|mdx|md)$/;
const APP_ROUTE = /^route\.(?:ts|js|tsx|jsx|mjs)$/;
const PAGES_FILE = /\.(?:tsx|jsx|ts|js|mdx|md)$/;

export function isNextConfig(rel: string): boolean {
  return NEXT_CONFIG.test(basenamePosix(rel));
}

/** App/pages router roots for a Next.js project directory (scope-relative). */
export function routerRoots(projectDir: string): { app: string[]; pages: string[] } {
  return {
    app: [joinPosix(projectDir, "app"), joinPosix(projectDir, "src/app")],
    pages: [joinPosix(projectDir, "pages"), joinPosix(projectDir, "src/pages")],
  };
}

/** The route a file defines under the Next.js App Router or Pages Router, if any. */
export function detectRoute(file: SourceFile, projectDirs: Iterable<string>): RouteInfo | undefined {
  if (file.isTest) return undefined;
  const rel = file.rel;
  const base = basenamePosix(rel);
  for (const dir of projectDirs) {
    const roots = routerRoots(dir);
    for (const root of roots.app) {
      if (!rel.startsWith(`${root}/`)) continue;
      const isPage = APP_PAGE.test(base);
      const isHandler = APP_ROUTE.test(base);
      if (!isPage && !isHandler) return undefined;
      const segments = dirnamePosix(rel.slice(root.length + 1)).split("/").filter(Boolean);
      if (segments.some((s) => s.startsWith("_"))) return undefined;
      const url = segments.filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@")).join("/");
      return { id: `route:${file.scope}/${url}`, url, api: isHandler, router: "app" };
    }
    for (const root of roots.pages) {
      if (!rel.startsWith(`${root}/`)) continue;
      if (!PAGES_FILE.test(base) || base.startsWith("_")) return undefined;
      const segments = rel.slice(root.length + 1).replace(PAGES_FILE, "").split("/").filter(Boolean);
      if (segments.some((s) => s.startsWith("_"))) return undefined;
      if (segments[segments.length - 1] === "index") segments.pop();
      const url = segments.join("/");
      return { id: `route:${file.scope}/${url}`, url, api: segments[0] === "api", router: "pages" };
    }
  }
  return undefined;
}
