import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * Resolves `path` against `root` and refuses anything that lands outside it, following symlinks:
 * a committed link (`page.tsx -> ../../.zshrc`) must not let a write escape the project. For a path
 * that doesn't exist yet, its nearest existing ancestor is checked instead.
 */
export function resolveInRoot(root: string, path: string): string {
  const abs = resolve(root, path);
  const outside = (candidate: string, base: string) => {
    const rel = relative(base, candidate);
    return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);
  };
  if (outside(abs, resolve(root))) throw new Error(`path "${path}" is outside the project root`);

  const realRoot = realpathSync(root);
  let existing = abs;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  if (outside(realpathSync(existing), realRoot)) throw new Error(`path "${path}" resolves outside the project root (symlink)`);
  return abs;
}
