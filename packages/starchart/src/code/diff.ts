import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodeConfig } from "../config/schema.js";
import type { Graph } from "../core/graph.js";
import type { GraphNode } from "../core/model.js";
import { classify, isTestPath, scopeDefs, scopeForPath } from "./files.js";

const run = promisify(execFile);

/** Changes to one file between the base revision and the working tree. */
export interface FileChange {
  path: string;
  deleted: boolean;
  /** Whole file changed (new, untracked or binary). */
  whole: boolean;
  /** Inclusive new-file line ranges that were added or modified. */
  ranges: [number, number][];
  /** Pure deletions: lines were removed between new-file line N and N+1. */
  gaps: number[];
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd: root, maxBuffer: 512 * 1024 * 1024, encoding: "utf8" });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args.filter((a) => !a.startsWith("-c")).join(" ")} failed: ${(e.stderr || e.message).trim()}`);
  }
}

/** Decodes git's C-style quoted paths ("a/caf\303\251.txt"). */
export function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
      continue;
    }
    const n = body[i + 1];
    if (n !== undefined && /[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", a: "\u0007", b: "\b", f: "\f", v: "\v" };
    for (const b of Buffer.from(map[n ?? ""] ?? n ?? "", "utf8")) bytes.push(b);
    i++;
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripPrefix(p: string): string {
  const u = unquoteGitPath(p.trim());
  return u.replace(/^[ab]\//, "");
}

/**
 * Rejects revisions git would parse as options. `execFile` stops shell injection, but a base like
 * `--output=/some/file` would still be read by git as a flag and write wherever it points.
 */
export function assertSafeRev(rev: string): void {
  if (!rev || rev.startsWith("-") || /[\0\n\r]/.test(rev)) throw new Error(`invalid git revision: ${JSON.stringify(rev)}`);
}

/** Parses `git diff --unified=0` output. */
export function parseUnifiedDiff(output: string): FileChange[] {
  const out: FileChange[] = [];
  let cur: FileChange | undefined;
  let oldPath: string | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (cur) out.push(cur);
      const rest = line.slice("diff --git ".length);
      const quoted = rest.indexOf(' "b/');
      const path = stripPrefix(quoted >= 0 ? rest.slice(quoted + 1) : rest.slice(rest.lastIndexOf(" b/") + 1));
      cur = { path, deleted: false, whole: false, ranges: [], gaps: [] };
      oldPath = undefined;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("--- ")) {
      const p = line.slice(4);
      oldPath = p === "/dev/null" ? undefined : stripPrefix(p);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p === "/dev/null") {
        cur.deleted = true;
        if (oldPath) cur.path = oldPath;
      } else cur.path = stripPrefix(p);
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      cur.deleted = true;
      continue;
    }
    if (line.startsWith("new file mode")) {
      cur.whole = true;
      continue;
    }
    if (line.startsWith("Binary files ")) {
      cur.whole = true;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count === 0) cur.gaps.push(start);
      else cur.ranges.push([start, start + count - 1]);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function overlaps(ranges: [number, number][], gaps: number[], start: number, end: number): boolean {
  for (const [a, b] of ranges) if (a <= end && start <= b) return true;
  for (const g of gaps) if (start <= g && g < end) return true;
  return false;
}

interface FileIndex {
  fileNode?: string;
  symbols: GraphNode[];
  i18n: { id: string; line: number }[];
}

function indexGraph(graph: Graph): Map<string, FileIndex> {
  const index = new Map<string, FileIndex>();
  const get = (path: string) => {
    let entry = index.get(path);
    if (!entry) index.set(path, (entry = { symbols: [], i18n: [] }));
    return entry;
  };
  for (const n of graph.nodes()) {
    if (n.kind === "file" || n.kind === "test") {
      const path = (n.meta?.path as string | undefined) ?? n.location?.file;
      if (path) get(path).fileNode = n.id;
    } else if (n.kind === "symbol" && n.location?.file) {
      get(n.location.file).symbols.push(n);
    } else if (n.kind === "i18n") {
      const locations = (n.meta?.locations as { file: string; line: number }[] | undefined) ?? (n.location?.file ? [{ file: n.location.file, line: n.location.line ?? 1 }] : []);
      for (const l of locations) get(l.file).i18n.push({ id: n.id, line: l.line });
    }
  }
  return index;
}

/** Maps a list of file changes to the code node ids they touch. */
export function changedNodes(changes: FileChange[], config: CodeConfig, graph: Graph): string[] {
  const scopes = scopeDefs(config);
  const index = indexGraph(graph);
  const ids = new Set<string>();
  for (const change of changes) {
    const entry = index.get(change.path);
    let fileId = entry?.fileNode;
    if (!fileId) {
      const hit = scopeForPath(scopes, change.path);
      const cls = hit ? classify(hit.rel) : undefined;
      if (hit && cls && (cls.role === "code" || cls.role === "mdx")) {
        const isTest = cls.role === "code" && isTestPath(hit.rel, cls.lang);
        fileId = `${isTest ? "test" : "file"}:${hit.scope.name}/${hit.rel}`;
      }
    }
    if (fileId) ids.add(fileId);
    if (change.deleted || !entry) continue;

    for (const s of entry.symbols) {
      const ranges = (s.meta?.ranges as [number, number][] | undefined) ?? [[s.location!.line ?? 1, s.location!.endLine ?? s.location!.line ?? 1]];
      if (change.whole || ranges.some(([a, b]) => overlaps(change.ranges, change.gaps, a, b))) ids.add(s.id);
    }

    if (entry.i18n.length) {
      const sorted = [...entry.i18n].sort((a, b) => a.line - b.line);
      let any = false;
      sorted.forEach((k, i) => {
        const next = sorted.slice(i + 1).find((x) => x.line > k.line);
        const end = next ? next.line - 1 : Number.MAX_SAFE_INTEGER;
        if (change.whole || overlaps(change.ranges, change.gaps, k.line, Math.max(k.line, end))) {
          ids.add(k.id);
          any = true;
        }
      });
      if (!any) for (const k of sorted) ids.add(k.id);
    }
  }
  return [...ids].sort();
}

/**
 * Runs `git diff --unified=0 <base>` (plus untracked files) in `root` and maps every hunk
 * to the file/test node and the symbols and localization keys whose ranges it touches.
 */
export async function changedNodesFromGit(root: string, config: CodeConfig, graph: Graph, base: string): Promise<string[]> {
  assertSafeRev(base);
  const diff = await git(root, ["-c", "core.quotePath=false", "diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-renames", "--relative", "--end-of-options", base, "--"]);
  const untracked = await git(root, ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"]);
  const changes = parseUnifiedDiff(diff);
  for (const line of untracked.split("\n")) {
    const path = unquoteGitPath(line.trim());
    if (path) changes.push({ path, deleted: false, whole: true, ranges: [], gaps: [] });
  }
  return changedNodes(changes, config, graph);
}
