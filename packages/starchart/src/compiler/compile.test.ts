import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProject, ConfigError } from "../config/load.js";
import { Graph } from "../core/graph.js";
import { compileProject, resolveCodeFacts } from "./compile.js";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "starchart-compile-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ".starchart", path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("compileProject", () => {
  it("flattens nested facts into leaf and container nodes with partOf edges", () => {
    const root = project({
      "config.yaml": "name: t\n",
      "pro.yaml": [
        "id: addon:pro",
        "type: schema:Offer",
        "status: active",
        "facts:",
        "  name: Pro",
        "  price: { usd: 4.99, eur: 4.49 }",
        "  productId: { value: pro_monthly, authority: appstore }",
        "  features: [themes, sync]",
      ].join("\n"),
    });
    const { graph } = compileProject(loadProject(root));

    expect(graph.node("addon:pro")?.types).toEqual(["schema:Offer"]);
    expect(graph.node("addon:pro.price")?.value).toEqual({ usd: 4.99, eur: 4.49 });
    expect(graph.node("addon:pro.price.usd")?.value).toBe(4.99);
    expect(graph.node("addon:pro.productId")?.authority).toBe("appstore");
    expect(graph.node("addon:pro.features")?.value).toEqual(["themes", "sync"]);
    expect(graph.node("addon:pro.status")?.value).toBe("active");
    expect(graph.outgoing("addon:pro.price.usd", "partOf").map((e) => e.to)).toEqual(["addon:pro.price"]);
    expect(graph.outgoing("addon:pro.price", "partOf").map((e) => e.to)).toEqual(["addon:pro"]);
  });

  it("compiles artifacts, renders templates, publishedBy, and section files", () => {
    const root = project({
      "entities.yaml": "entities:\n  - id: addon:pro\n    facts: { name: Pro }\n",
      "web.yaml": [
        "artifacts:",
        "  - id: web:pricing",
        "    binding: { adapter: fs, path: web/pricing.tsx }",
        "    embeds: addon:pro.name",
        "    publishedBy: route:web/pricing",
        "  - id: web:og",
        "    renders: { template: og.svg, with: [addon:pro.name] }",
        "edges:",
        "  - { from: screen:ios/Paywall, to: addon:pro.name, type: displays }",
      ].join("\n"),
    });
    const { graph, danglingTargets } = compileProject(loadProject(root));
    expect(graph.outgoing("web:pricing", "embeds").map((e) => e.to)).toEqual(["addon:pro.name"]);
    expect(graph.outgoing("route:web/pricing", "publishes").map((e) => e.to)).toEqual(["web:pricing"]);
    expect(graph.node("web:og")?.meta?.template).toBe("og.svg");
    expect(graph.outgoing("web:og", "renders")).toHaveLength(1);
    // code nodes are satisfied later by ingest
    expect(danglingTargets.map((d) => d.missing).sort()).toEqual(["route:web/pricing", "screen:ios/Paywall"]);
  });

  it("resolves code-authority facts from symbols and adds anchors", () => {
    const root = project({
      "pro.yaml": "id: addon:pro\nfacts:\n  features: { authority: code, source: { symbol: ios/Entitlements.proFeatures } }\n",
    });
    const { graph, pendingCodeFacts } = compileProject(loadProject(root));
    expect(pendingCodeFacts).toEqual([{ factId: "addon:pro.features", symbol: "symbol:ios/Entitlements.proFeatures" }]);

    const code = new Graph();
    code.addNode({ id: "symbol:ios/Entitlements.proFeatures", kind: "symbol", value: ["themes", "sync", "widgets"] });
    graph.merge(code);
    expect(resolveCodeFacts(graph, pendingCodeFacts).unresolved).toEqual([]);
    expect(graph.node("addon:pro.features")?.value).toEqual(["themes", "sync", "widgets"]);
    expect(graph.outgoing("symbol:ios/Entitlements.proFeatures", "anchors").map((e) => e.to)).toEqual(["addon:pro.features"]);
  });

  it("reports schema errors with the file name", () => {
    const root = project({ "bad.yaml": "artifacts:\n  - binding: { adapter: fs }\n" });
    expect(() => loadProject(root)).toThrow(ConfigError);
    expect(() => loadProject(root)).toThrow(/bad\.yaml.*id/);
  });

  it("rejects unknown edge types", () => {
    const root = project({ "e.yaml": "edges:\n  - { from: a, to: b, type: teleports }\n" });
    expect(() => compileProject(loadProject(root))).toThrow(/unknown edge type "teleports"/);
  });
});
