import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canWrite, getAdapter } from "../src/adapters/registry.js";
import { check, planFromLock } from "../src/api.js";
import { parseAnnotations } from "../src/code/annotations.js";
import { Graph } from "../src/core/graph.js";
import { computeImpact } from "../src/core/impact.js";
import { buildLock, relockArtifacts, staleArtifacts } from "../src/core/lock.js";
import { buildProject } from "../src/project.js";
import { loadPacks } from "../src/rules/packs/index.js";
import { importTokens } from "../src/tokens.js";

const EXAMPLE = resolve(import.meta.dirname, "../../../examples/pro-universe");

function demoCopy(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "starchart-reg-")), "u");
  cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !src.includes("/.starchart/journal") });
  return dir;
}

describe("plan and check agree after partial relocks", () => {
  it("keeps old values for still-stale artifacts and keeps planning them", async () => {
    const dir = demoCopy();
    const pro = join(dir, ".starchart/entities/pro.yaml");
    writeFileSync(pro, readFileSync(pro, "utf8").replace("usd: 4.99", "usd: 5.99"));
    const project = await buildProject(dir);

    project.lock = relockArtifacts(project.graph, project.lock, ["web:pricing-page"]);
    const stale = check(project).map((s) => s.id);
    expect(stale).not.toContain("web:pricing-page");
    expect(stale).toContain("web:messages-en");
    // the old value survives so fs can still find "4.99" in the other files
    expect(project.lock.facts["addon:pro.price.usd"]?.value).toBe(4.99);

    const planned = planFromLock(project).impact.items.filter((i) => i.node.kind === "artifact").map((i) => i.id);
    expect(planned).toContain("web:messages-en");
    expect(planned).not.toContain("web:pricing-page");
    expect(new Set(planned)).toEqual(new Set(stale));
  });

  it("records maxCodeDepth in the lock and uses it for staleness", () => {
    const g = new Graph();
    g.addNode({ id: "a", kind: "artifact" });
    g.addNode({ id: "screen:x/S", kind: "screen", hash: "1" });
    g.addNode({ id: "symbol:x/A", kind: "symbol", hash: "1" });
    g.addNode({ id: "symbol:x/B", kind: "symbol", hash: "1" });
    g.addEdge({ from: "a", to: "screen:x/S", type: "captures" });
    g.addEdge({ from: "screen:x/S", to: "symbol:x/A", type: "references" });
    g.addEdge({ from: "symbol:x/A", to: "symbol:x/B", type: "references" });
    const lock = buildLock(g, undefined, undefined, { maxCodeDepth: 1 });
    expect(lock.maxCodeDepth).toBe(1);
    expect(Object.keys(lock.artifacts.a!.deps)).toEqual(["screen:x/S", "symbol:x/A"]);
    g.addNode({ id: "symbol:x/B", kind: "symbol", hash: "2" }); // beyond depth 1: not a dependency
    expect(staleArtifacts(g, lock)).toEqual([]);
  });
});

describe("per-binding write capability", () => {
  it("plans App Store screenshots and IAPs as manual even with writes enabled", () => {
    const settings = { appstore: { write: true } };
    const shot = { id: "s", kind: "artifact" as const, layer: "world" as const, binding: { adapter: "appstore", app: "1", set: "6.9", index: 3 } };
    const text = { id: "t", kind: "artifact" as const, layer: "world" as const, binding: { adapter: "appstore", app: "1", field: "promotionalText" } };
    expect(canWrite("appstore", settings, shot)).toBe(false);
    expect(canWrite("appstore", settings, text)).toBe(true);
    expect(canWrite("appstore", {}, text)).toBe(false); // external writes stay opt-in
    expect(getAdapter("appstore")?.canApply?.(shot)).toBe(false);
  });
});

describe("annotations and tokens", () => {
  it("accepts dotted fact ids without a colon as annotation targets", () => {
    const [ann] = parseAnnotations({ text: "@starchart anchors tokens.color.brand.primary", line: 1 });
    expect(ann?.targets).toEqual(["tokens.color.brand.primary"]);
  });

  it("links token aliases to their target so impact follows them", () => {
    const root = mkdtempSync(join(tmpdir(), "starchart-tokens-"));
    writeFileSync(
      join(root, "tokens.json"),
      JSON.stringify({ color: { brand: { primary: { $value: "#ff1493", $type: "color" } }, cta: { $value: "{color.brand.primary}", $type: "color" } } }),
    );
    const g = new Graph();
    importTokens(g, root, ["tokens.json"]);
    g.addNode({ id: "web:button", kind: "artifact", binding: { adapter: "fs", path: "b.css" } });
    g.addEdge({ from: "web:button", to: "tokens.color.cta", type: "embeds" });
    const ids = computeImpact(g, ["tokens.color.brand.primary"]).items.map((i) => i.id);
    expect(ids).toContain("web:button");
  });
});

describe("plugins", () => {
  it("loads adapters and rule packs from config", async () => {
    const dir = demoCopy();
    mkdirSync(join(dir, "plugins"));
    writeFileSync(
      join(dir, "plugins/cms.mjs"),
      [
        "export const adapters = [{ id: 'cms', capabilities: { read: true }, async audit() { return []; } }];",
        "export const packs = [{ id: 'house', description: 'house rules', rules: [] }];",
      ].join("\n"),
    );
    const config = join(dir, ".starchart/config.yaml");
    writeFileSync(config, `${readFileSync(config, "utf8")}plugins: [./plugins/cms.mjs]\n`);
    await buildProject(dir);
    expect(getAdapter("cms")?.id).toBe("cms");
    expect(loadPacks(["house"]).unknown).toEqual([]);
  });
});
