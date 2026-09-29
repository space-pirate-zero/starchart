import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LOCK_FILE } from "./config/load.js";
import { emptyLock, stableStringify, type LockFile } from "./core/lock.js";

/**
 * Time machine: the lock is committed, so git history is the history of every fact value.
 * All git calls use execFile (no shell).
 */

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: root, maxBuffer: MAX_BUFFER, encoding: "utf8" });
  return stdout;
}

export interface FactVersion {
  commit: string;
  /** Author date, ISO 8601. */
  date: string;
  author: string;
  subject: string;
  /** Fact value in that commit's lock (undefined when the fact was absent). */
  value: unknown;
}

function parseLock(text: string): LockFile | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<LockFile>;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return undefined;
    return { ...emptyLock(), ...parsed } as LockFile;
  } catch {
    return undefined;
  }
}

async function lockAtCommit(root: string, commit: string): Promise<LockFile | undefined> {
  try {
    return parseLock(await git(root, ["show", `${commit}:./${LOCK_FILE}`]));
  } catch {
    return undefined;
  }
}

/**
 * History of one fact's value across commits that touched `starchart.lock`, newest first.
 * Consecutive commits with an identical value collapse into one entry: the oldest commit where
 * that value first appeared. Returns [] outside a git repo or when the lock was never committed.
 */
export async function factHistory(root: string, factId: string, opts: { limit?: number } = {}): Promise<FactVersion[]> {
  const limit = Math.max(1, Math.floor(opts.limit ?? 50));
  let log: string;
  try {
    log = await git(root, ["log", "--format=%H%x09%aI%x09%an%x09%s", "-n", String(limit), "--", LOCK_FILE]);
  } catch {
    return [];
  }
  const commits = log
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [commit = "", date = "", author = "", ...subject] = line.split("\t");
      return { commit, date, author, subject: subject.join("\t") };
    })
    .filter((c) => /^[0-9a-f]{7,64}$/.test(c.commit));

  const versions = await Promise.all(
    commits.map(async (c) => {
      const lock = await lockAtCommit(root, c.commit);
      return { ...c, value: lock?.facts[factId]?.value } satisfies FactVersion;
    }),
  );

  const out: FactVersion[] = [];
  let runKey: string | undefined;
  for (const version of versions) {
    const key = version.value === undefined ? "\u0000absent" : stableStringify(version.value);
    if (out.length > 0 && key === runKey) {
      // same value as the newer entry: move the entry back to this older commit
      out[out.length - 1] = version;
    } else {
      out.push(version);
      runKey = key;
    }
  }
  return out;
}

/** The lock as committed at `rev`. Throws for an unknown revision; empty lock when the file did not exist yet. */
export async function lockAt(root: string, rev: string): Promise<LockFile> {
  if (rev.startsWith("-")) throw new Error(`invalid revision "${rev}"`);
  let commit: string;
  try {
    commit = (await git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])).trim();
  } catch {
    throw new Error(`unknown revision "${rev}"`);
  }
  if (!commit) throw new Error(`unknown revision "${rev}"`);
  let text: string;
  try {
    text = await git(root, ["show", `${commit}:./${LOCK_FILE}`]);
  } catch {
    return emptyLock();
  }
  const lock = parseLock(text);
  if (!lock) throw new Error(`${LOCK_FILE} at ${rev} is not a valid version 1 lock`);
  return lock;
}
