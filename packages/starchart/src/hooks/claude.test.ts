import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLock } from "../core/lock.js";
import { buildProject, writeLock } from "../project.js";
import { claudeHookSettingsSnippet, runClaudeHook, shortPath } from "./claude.js";

let root: string;
let outside: string;

const ENTITY = (price: number) => `id: addon:pro
type: [schema:Offer]
status: active
facts:
  name: "Pro+"
  price: { usd: ${price} }
`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "starchart-hook-"));
  outside = mkdtempSync(join(tmpdir(), "starchart-hook-outside-"));
  mkdirSync(join(root, ".starchart"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "site"), { recursive: true });
  writeFileSync(join(root, ".starchart/config.yaml"), "name: hook-test\ncode:\n  scopes:\n    app: src\n");
  writeFileSync(join(root, ".starchart/pro.yaml"), ENTITY(4.99));
  writeFileSync(
    join(root, ".starchart/artifacts.yaml"),
    `- id: web:pricing
  binding: { adapter: fs, path: site/pricing.html }
  embeds: [addon:pro.price.usd]
- id: web:og-pricing
  type: schema:ImageObject
  derivedFrom: web:pricing
- id: appstore:iap/pro
  binding: { adapter: appstore, iap: pro_monthly }
  mirrors: [addon:pro.price]
`,
  );
  writeFileSync(join(root, "site/pricing.html"), "<p>Pro+ is $4.99</p>");
  const project = await buildProject(root, { skipCode: true });
  writeLock(root, buildLock(project.graph));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const event = (file: string, tool = "Write", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: file, content: "x" }, cwd: root, ...extra });

describe("runClaudeHook", () => {
  it("returns additionalContext for a file bound as a world artifact", async () => {
    const out = await runClaudeHook(event(join(root, "site/pricing.html")));
    expect(out).not.toBe("");
    const parsed = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx.length).toBeLessThanOrEqual(1500);
    expect(ctx).toContain("STARCHART: editing site/pricing.html");
    expect(ctx).toContain("world artifact web:pricing");
    expect(ctx).toContain("addon:pro.price.usd");
    expect(ctx).toContain("web:og-pricing");
    expect(ctx).toContain("-derivedFrom→ web:og-pricing");
    expect(ctx).toContain("starchart plan");
  });

  it("accepts relative paths resolved against the event cwd", async () => {
    const out = await runClaudeHook(event("site/pricing.html", "Edit"));
    expect(out).toContain("web:og-pricing");
  });

  it("reports fact edits in .starchart/ against the lock", async () => {
    writeFileSync(join(root, ".starchart/pro.yaml"), ENTITY(5.99));
    try {
      const out = await runClaudeHook(event(join(root, ".starchart/pro.yaml"), "Edit"));
      const ctx = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      expect(ctx).toContain("fact edits in .starchart/pro.yaml");
      expect(ctx).toContain("appstore:iap/pro");
      expect(ctx).toMatch(/[~!] (auto|manual) appstore:iap\/pro — /);
      expect(ctx).toContain("Run `starchart plan` for the full blast radius.");
    } finally {
      writeFileSync(join(root, ".starchart/pro.yaml"), ENTITY(4.99));
    }
  });

  it("returns nothing for files outside a project", async () => {
    const file = join(outside, "notes.md");
    writeFileSync(file, "hello");
    expect(await runClaudeHook(event(file, "Write", { cwd: outside }))).toBe("");
  });

  it("returns nothing for unrelated files, other tools and other events", async () => {
    writeFileSync(join(root, "README.md"), "readme");
    expect(await runClaudeHook(event(join(root, "README.md")))).toBe("");
    expect(await runClaudeHook(event(join(root, "site/pricing.html"), "Read"))).toBe("");
    expect(await runClaudeHook(event(join(root, "site/pricing.html"), "Write", { hook_event_name: "PreToolUse" }))).toBe("");
    expect(await runClaudeHook("")).toBe("");
  });

  it("swallows errors unless debugging", async () => {
    expect(await runClaudeHook("{not json")).toBe("");
    const debug = await runClaudeHook("{not json", { env: { STARCHART_HOOK_DEBUG: "1" } });
    expect(debug).toContain("STARCHART hook error");
  });
});

describe("helpers", () => {
  it("shortens long why-paths", () => {
    const path = [
      { from: "file:app/a.ts", to: "symbol:app/a.X", type: "contains" as const },
      { from: "symbol:app/a.X", to: "symbol:app/b.Y", type: "references" as const },
      { from: "symbol:app/b.Y", to: "screen:app/Paywall", type: "references" as const },
      { from: "screen:app/Paywall", to: "appstore:shot/03", type: "captures" as const },
    ];
    expect(shortPath(path, "app/a.ts")).toBe("a.ts -contains→ symbol:app/a.X … -captures→ appstore:shot/03");
  });

  it("exposes the settings snippet", () => {
    expect(claudeHookSettingsSnippet()).toEqual({
      hooks: { PostToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "npx @spz/starchart hook claude" }] }] },
    });
  });
});
