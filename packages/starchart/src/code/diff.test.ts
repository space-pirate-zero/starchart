import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodeConfig } from "../config/schema.js";
import { changedNodes, parseUnifiedDiff, unquoteGitPath } from "./diff.js";
import { changedNodesFromDiff, ingestCode } from "./index.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/universe", import.meta.url));
const CONFIG: CodeConfig = { scopes: { web: "web", ios: "ios", android: "android", api: "api" }, exclude: [] };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=STARCHART", "-c", "user.email=starchart@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

function edit(root: string, rel: string, from: string, to: string): void {
  const path = join(root, rel);
  const text = readFileSync(path, "utf8");
  if (!text.includes(from)) throw new Error(`${rel} does not contain ${from}`);
  writeFileSync(path, text.replace(from, to));
}

describe("parseUnifiedDiff", () => {
  it("reads new-file ranges, pure deletions, new, deleted and binary files", () => {
    const out = parseUnifiedDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1..2 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -3 +3 @@ x",
        "-a",
        "+b",
        "@@ -10,2 +9,0 @@",
        "@@ -20,0 +20,3 @@",
        "diff --git a/old.ts b/old.ts",
        "deleted file mode 100644",
        "--- a/old.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "diff --git a/new.ts b/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1 @@",
        "diff --git a/img.png b/img.png",
        "Binary files a/img.png and b/img.png differ",
        'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
        '--- "a/caf\\303\\251.ts"',
        '+++ "b/caf\\303\\251.ts"',
        "@@ -1 +1 @@",
      ].join("\n"),
    );
    expect(out).toEqual([
      { path: "src/a.ts", deleted: false, whole: false, ranges: [[3, 3], [20, 22]], gaps: [9] },
      { path: "old.ts", deleted: true, whole: false, ranges: [], gaps: [0] },
      { path: "new.ts", deleted: false, whole: true, ranges: [[1, 1]], gaps: [] },
      { path: "img.png", deleted: false, whole: true, ranges: [], gaps: [] },
      { path: "café.ts", deleted: false, whole: false, ranges: [[1, 1]], gaps: [] },
    ]);
    expect(unquoteGitPath('"a\\tb"')).toBe("a\tb");
  });
});

describe("changedNodesFromDiff", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "starchart-diff-"));
    cpSync(FIXTURE, root, { recursive: true });
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "initial");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("maps hunks to the symbols, i18n keys and files they touch", async () => {
    // modify one Swift member: only it and its enclosing type change, not its siblings
    edit(root, "ios/Sources/Core/Pricing.swift", "static let proUSD = 4.99", "static let proUSD = 5.99");
    // modify a TS constant
    edit(root, "web/lib/pricing.ts", '"price_1ProMonthly499"', '"price_1ProMonthly599"');
    // rewrite inside a Go method body
    edit(root, "api/internal/pricing/pricing.go", "\treturn p.Price + ProUSD\n", "\tp.Price += ProUSD\n\n\treturn p.Price\n");
    // pure deletion (no added lines) strictly inside a SwiftUI body
    edit(root, "ios/Sources/Paywall/PaywallView.swift", '            Text(verbatim: "not a key")\n', "");
    // change one localized string
    edit(root, "web/messages/en.json", "Go further with Nebula Pro", "Go further, faster");
    // a comment-only change between declarations touches the file but no symbol
    edit(root, "android/app/src/main/java/com/nebula/Pricing.kt", "package com.nebula\n", "package com.nebula\n\n// pricing constants\n");
    // delete a file and add an untracked one
    unlinkSync(join(root, "web/lib/analytics.ts"));
    writeFileSync(join(root, "web/lib/coupons.ts"), 'export const COUPON = "SPRING";\n');

    const graph = await ingestCode(root, CONFIG);
    const ids = await changedNodesFromDiff(root, CONFIG, graph, "HEAD");

    expect(ids).toContain("file:ios/Sources/Core/Pricing.swift");
    expect(ids).toContain("symbol:ios/Pricing.proUSD");
    expect(ids).toContain("symbol:ios/Pricing");
    expect(ids).not.toContain("symbol:ios/Pricing.currency");
    expect(ids).not.toContain("symbol:ios/Pricing.tiers");

    expect(ids).toContain("file:web/lib/pricing.ts");
    expect(ids).toContain("symbol:web/lib/pricing#PRICE_ID");
    expect(ids).not.toContain("symbol:web/lib/pricing#PRO_PRICE_USD");

    expect(ids).toContain("symbol:ios/PaywallView.body");
    expect(ids).toContain("symbol:ios/PaywallView");
    expect(ids).not.toContain("symbol:ios/PaywallView.purchase");
    expect(ids).not.toContain("symbol:ios/PaywallView.isPurchasing");

    expect(ids).toContain("symbol:api/internal/pricing.Plan.Total");
    expect(ids).not.toContain("symbol:api/internal/pricing.Plan");

    expect(ids).toContain("file:web/messages/en.json");
    expect(ids).toContain("i18n:web/pricing.title");
    expect(ids).not.toContain("i18n:web/pricing.cta");

    expect(ids).toContain("file:android/app/src/main/java/com/nebula/Pricing.kt");
    expect(ids.filter((id) => id.startsWith("symbol:android/"))).toEqual([]);

    expect(ids).toContain("file:web/lib/analytics.ts");
    expect(ids).toContain("file:web/lib/coupons.ts");
    expect(ids).toContain("symbol:web/lib/coupons#COUPON");

    expect(ids.filter((id) => id.startsWith("symbol:web/app/"))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps a whole-file change to every node in that file", () => {
    const graph = { nodes: () => [] } as unknown as Parameters<typeof changedNodes>[2];
    expect(changedNodes([{ path: "ios/Sources/New.swift", deleted: false, whole: true, ranges: [], gaps: [] }], CONFIG, graph)).toEqual(["file:ios/Sources/New.swift"]);
    expect(changedNodes([{ path: "ios/Tests/NewTests.swift", deleted: true, whole: false, ranges: [], gaps: [] }], CONFIG, graph)).toEqual(["test:ios/Tests/NewTests.swift"]);
    expect(changedNodes([{ path: "docs/notes.png", deleted: false, whole: true, ranges: [], gaps: [] }], CONFIG, graph)).toEqual([]);
  });

  it("fails clearly outside a git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "starchart-nogit-"));
    try {
      const graph = await ingestCode(dir, { scopes: { app: "." }, exclude: [] });
      await expect(changedNodesFromDiff(dir, { scopes: { app: "." }, exclude: [] }, graph, "HEAD")).rejects.toThrow(/git .*failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
