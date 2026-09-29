import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Graph } from "./core/graph.js";
import { computeImpact } from "./core/impact.js";
import { flattenTokens, importTokens } from "./tokens.js";

const core = {
  color: {
    $type: "color",
    brand: {
      primary: { $value: "#7c3aed", $description: "Nebula purple" },
      secondary: { $value: "{color.brand.primary}" },
    },
  },
  space: { $type: "dimension", sm: { $value: "4px" }, md: { $value: "8px" } },
};

const semantic = {
  button: {
    background: { $value: "{color.brand.secondary}" },
    border: { $value: "1px solid {color.brand.primary}", $type: "border" },
    shadow: { $type: "shadow", $value: { color: "{color.brand.primary}", offsetX: "{space.sm}", blur: "0px" } },
  },
};

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("flattenTokens", () => {
  it("flattens groups, inherits $type, and resolves aliases", () => {
    const tokens = flattenTokens(core);
    const byPath = Object.fromEntries(tokens.map((t) => [t.path, t]));
    expect(Object.keys(byPath)).toEqual(["color.brand.primary", "color.brand.secondary", "space.sm", "space.md"]);
    expect(byPath["color.brand.primary"]).toMatchObject({ value: "#7c3aed", type: "color", description: "Nebula purple" });
    expect(byPath["color.brand.secondary"]).toMatchObject({ value: "#7c3aed", raw: "{color.brand.primary}", aliasOf: "color.brand.primary", type: "color" });
    expect(byPath["space.md"]?.type).toBe("dimension");
  });

  it("rejects unknown and circular aliases", () => {
    expect(() => flattenTokens({ a: { $value: "{b}" } })).toThrow(/unknown token/);
    expect(() => flattenTokens({ a: { $value: "{b}" }, b: { $value: "{a}" } })).toThrow(/circular/);
  });
});

describe("importTokens", () => {
  it("adds a tokens entity with fact nodes and resolves aliases across files", () => {
    const root = mkdtempSync(join(tmpdir(), "starchart-tokens-"));
    dirs.push(root);
    writeFileSync(join(root, "core.tokens.json"), JSON.stringify(core));
    writeFileSync(join(root, "semantic.tokens.json"), JSON.stringify(semantic));
    const g = new Graph();
    expect(importTokens(g, root, ["core.tokens.json", "semantic.tokens.json"])).toEqual({ count: 7 });

    expect(g.node("tokens")).toMatchObject({ kind: "entity", types: ["sc:DesignTokens"] });
    expect(g.node("tokens.color.brand.primary")).toMatchObject({ kind: "fact", value: "#7c3aed", meta: { tokenType: "color", description: "Nebula purple" } });
    expect(g.node("tokens.button.background")).toMatchObject({ value: "#7c3aed", meta: { aliasOf: "tokens.color.brand.secondary" } });
    expect(g.node("tokens.button.border")?.value).toBe("1px solid #7c3aed");
    expect(g.node("tokens.button.shadow")?.value).toEqual({ color: "#7c3aed", offsetX: "4px", blur: "0px" });
    expect(g.node("tokens.color.brand")?.value).toEqual({ primary: "#7c3aed", secondary: "#7c3aed" });
    expect(g.outgoing("tokens.color.brand.primary", "partOf")[0]?.to).toBe("tokens.color.brand");
    expect(g.outgoing("tokens.color", "partOf")[0]?.to).toBe("tokens");

    // a rebrand has a blast radius
    g.addNode({ id: "og:template", kind: "artifact" });
    g.addEdge({ from: "og:template", to: "tokens.color.brand", type: "renders" });
    const { items } = computeImpact(g, ["tokens.color.brand.primary"]);
    expect(items.find((i) => i.id === "og:template")?.class).toBe("auto");
  });

  it("reports unreadable files", () => {
    expect(() => importTokens(new Graph(), tmpdir(), ["does-not-exist.json"])).toThrow(/cannot read design tokens/);
  });
});
