import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Graph } from "../core/graph.js";
import { scanLiterals } from "./scan.js";

describe("scanLiterals import lines", () => {
  it("ignores module imports that happen to equal a fact value", async () => {
    const root = mkdtempSync(join(tmpdir(), "starchart-scan-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "Tests.swift"), "@testable import Nebula\nimport Nebula\nlet title = \"Nebula\"\n");
    writeFileSync(join(root, "src", "index.ts"), 'export { x } from "Nebula";\nconst name = "Nebula";\n');
    const g = new Graph();
    g.addNode({ id: "app:nebula", kind: "entity" });
    g.addNode({ id: "app:nebula.name", kind: "fact", value: "Nebula" });
    g.addEdge({ from: "app:nebula.name", to: "app:nebula", type: "partOf" });

    const hits = await scanLiterals(root, g);
    expect(hits.map((h) => `${h.file}:${h.line}`).sort()).toEqual(["src/Tests.swift:3", "src/index.ts:2"]);
  });
});
