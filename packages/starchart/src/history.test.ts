import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { factHistory, lockAt } from "./history.js";

let repo: string;
let empty: string;

const env = (date?: string) => ({
  ...process.env,
  GIT_AUTHOR_NAME: "Zero",
  GIT_AUTHOR_EMAIL: "zero@example.com",
  GIT_COMMITTER_NAME: "Zero",
  GIT_COMMITTER_EMAIL: "zero@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: env() }).trim();

function commitLock(price: number | undefined, message: string, date: string, code: Record<string, string> = {}) {
  const facts = price === undefined ? {} : { "addon:pro.price.usd": { hash: String(price), value: price } };
  writeFileSync(join(repo, "starchart.lock"), JSON.stringify({ version: 1, facts, code, artifacts: {} }));
  git(repo, "add", "starchart.lock");
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repo, env: env(date) });
  return git(repo, "rev-parse", "HEAD");
}

const commits: string[] = [];

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "starchart-history-"));
  empty = mkdtempSync(join(tmpdir(), "starchart-nogit-"));
  git(repo, "init", "-q");
  commits.push(commitLock(undefined, "chore: init lock", "2026-01-01T00:00:00Z"));
  commits.push(commitLock(4.99, "feat: launch Pro", "2026-02-01T00:00:00Z"));
  commits.push(commitLock(4.99, "chore: relock\twith tab", "2026-03-01T00:00:00Z", { "symbol:web/x": "abc" }));
  commits.push(commitLock(5.99, "feat: Pro to 5.99", "2026-04-01T00:00:00Z"));
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

describe("factHistory", () => {
  it("lists value changes newest first, collapsing unchanged commits to the first appearance", async () => {
    const history = await factHistory(repo, "addon:pro.price.usd");
    expect(history.map((h) => h.value)).toEqual([5.99, 4.99, undefined]);
    expect(history[0]).toMatchObject({ commit: commits[3], subject: "feat: Pro to 5.99", author: "Zero" });
    expect(history[0]!.date.startsWith("2026-04-01")).toBe(true);
    // 4.99 first appeared in "launch Pro", not the later relock
    expect(history[1]).toMatchObject({ commit: commits[1], subject: "feat: launch Pro" });
    expect(history[2]?.commit).toBe(commits[0]);
  });

  it("honours the limit", async () => {
    const history = await factHistory(repo, "addon:pro.price.usd", { limit: 2 });
    expect(history.map((h) => h.value)).toEqual([5.99, 4.99]);
    expect(history[1]?.commit).toBe(commits[2]);
  });

  it("returns an empty list outside git", async () => {
    expect(await factHistory(empty, "addon:pro.price.usd")).toEqual([]);
  });
});

describe("lockAt", () => {
  it("reads the lock at a revision", async () => {
    const lock = await lockAt(repo, "HEAD~1");
    expect(lock.facts["addon:pro.price.usd"]?.value).toBe(4.99);
    expect((await lockAt(repo, commits[3]!)).facts["addon:pro.price.usd"]?.value).toBe(5.99);
  });

  it("rejects unknown revisions", async () => {
    await expect(lockAt(repo, "no-such-branch")).rejects.toThrow(/unknown revision/);
    await expect(lockAt(repo, "--output=x")).rejects.toThrow(/invalid revision/);
  });
});
