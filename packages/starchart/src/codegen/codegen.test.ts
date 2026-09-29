import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../compiler/compile.js";
import type { LoadedProject } from "../config/load.js";
import { EntityDoc, ProjectConfig } from "../config/schema.js";
import { emptyLock } from "../core/lock.js";
import type { Project } from "../project.js";
import { GENERATED_MARKER, generateCode, kotlinString, swiftString, writeCodegen } from "./index.js";

const tricky = 'Say "hi" \\ path\nnew line $name \\(x) café 🚀';

function loaded(root = "/tmp/none", codegen: unknown[] = []): LoadedProject {
  const entity = (doc: unknown) => ({ ...EntityDoc.parse(doc), file: ".starchart/entities.yaml" });
  return {
    root,
    config: ProjectConfig.parse({ codegen }),
    entities: [
      entity({
        id: "addon:pro",
        type: ["schema:Offer"],
        status: "active",
        facts: {
          name: "Pro+",
          price: { usd: 5.99, eur: 5.99, jpy: 800 },
          productId: { value: "pro_monthly", authority: "appstore" },
          features: ["themes", "sync"],
          trial: true,
          tagline: tricky,
          "default": "keyword key",
          limits: { value: { maxDevices: 3, "cloud-storage": "5GB" } },
          matrix: [{ a: 1 }, "b"],
          ratios: [1, 2.5],
          nothing: null,
          big: 3000000000,
        },
      }),
      entity({ id: "feature:themes", facts: { label: "Themes" } }),
    ],
    artifacts: [],
    edges: [],
    rules: [],
  };
}

function graph() {
  return compileProject(loaded()).graph;
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "starchart-codegen-"));
  tmpDirs.push(d);
  return d;
}

/** Type-checks generated TS plus a consumer file that asserts literal types. */
function typecheck(files: Record<string, string>): string[] {
  const dir = tmp();
  const paths = Object.entries(files).map(([name, text]) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  });
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
  };
  const program = ts.createProgram(paths, options);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("TypeScript codegen", () => {
  const out = generateCode(graph(), { lang: "ts", out: "facts.ts" });

  it("marks the file as generated and anchors every leaf", () => {
    expect(out.split("\n").slice(0, 5).join("\n")).toContain(GENERATED_MARKER);
    expect(out).toContain("// @starchart anchors addon:pro.price.usd\nexport const ADDON_PRO_PRICE_USD = 5.99;");
    expect(out).toContain('export const ADDON_PRO_FEATURES = ["themes", "sync"] as const;');
    expect(out).toContain("export const ADDON_PRO = {");
    expect(out).toContain('"addon:pro.price.usd": ADDON_PRO_PRICE_USD,');
    expect(out).toContain("export type FactId = keyof typeof FACTS;");
    // the auto status fact is kept
    expect(out).toContain('ADDON_PRO_STATUS = "active"');
  });

  it("type-checks and preserves literal types", () => {
    const consumer = [
      'import { ADDON_PRO, FACTS, FEATURE_THEMES, type FactId } from "./facts";',
      "const usd: 5.99 = ADDON_PRO.price.usd;",
      'const name: "Pro+" = ADDON_PRO.name;',
      'const pid: "pro_monthly" = ADDON_PRO.productId;',
      'const feats: readonly ["themes", "sync"] = ADDON_PRO.features;',
      "const devices: 3 = ADDON_PRO.limits.maxDevices;",
      'const id: FactId = "feature:themes.label";',
      'const label: "Themes" = FEATURE_THEMES.label;',
      'const fromMap: 800 = FACTS["addon:pro.price.jpy"];',
      "export { usd, name, pid, feats, devices, id, label, fromMap };",
    ].join("\n");
    expect(typecheck({ "facts.ts": out, "use.ts": consumer })).toEqual([]);
  });

  it("is deterministic", () => {
    expect(generateCode(graph(), { lang: "ts", out: "facts.ts" })).toBe(out);
  });

  it("filters entities", () => {
    const only = generateCode(graph(), { lang: "ts", out: "f.ts", entities: ["feature:themes"] });
    expect(only).toContain("FEATURE_THEMES");
    expect(only).not.toContain("ADDON_PRO");
  });
});

describe("Swift codegen", () => {
  const out = generateCode(graph(), { lang: "swift", out: "Facts.swift", name: "Facts" });

  it("emits nested enums with typed static lets", () => {
    expect(out.split("\n").slice(0, 5).join("\n")).toContain(GENERATED_MARKER);
    expect(out).toContain("public enum Facts {");
    expect(out).toContain("public enum AddonPro {");
    expect(out).toContain("public enum Price {");
    expect(out).toContain("// @starchart anchors addon:pro.price.usd\n            public static let usd: Double = 5.99");
    expect(out).toContain("public static let jpy: Int = 800");
    expect(out).toContain('public static let features: [String] = ["themes", "sync"]');
    expect(out).toContain("public static let ratios: [Double] = [1.0, 2.5]");
    expect(out).toContain("public static let trial: Bool = true");
    expect(out).toContain("public static let `default`: String");
    expect(out).toContain("public static let nothing: String? = nil");
    expect(out).toContain("public enum Limits {");
    expect(out).toContain("public static let cloudStorage: String = \"5GB\"");
  });

  it("escapes Swift string literals", () => {
    expect(swiftString(tricky)).toBe('"Say \\"hi\\" \\\\ path\\nnew line $name \\\\(x) caf\\u{E9} \\u{1F680}"');
  });

  const swiftc = (() => {
    try {
      execFileSync("swiftc", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!swiftc)("type-checks with swiftc", () => {
    const dir = tmp();
    const file = join(dir, "Facts.swift");
    writeFileSync(file, out);
    expect(() => execFileSync("swiftc", ["-typecheck", file], { stdio: "pipe" })).not.toThrow();
  });
});

describe("Kotlin codegen", () => {
  const out = generateCode(graph(), { lang: "kotlin", out: "Facts.kt", package: "com.spz.facts" });

  it("emits objects with const vals", () => {
    expect(out.split("\n").slice(0, 5).join("\n")).toContain(GENERATED_MARKER);
    expect(out).toContain("package com.spz.facts");
    expect(out).toContain("object StarchartFacts {");
    expect(out).toContain("object AddonPro {");
    expect(out).toContain('const val NAME: String = "Pro+"');
    expect(out).toContain("// @starchart anchors addon:pro.price.usd\n            const val USD: Double = 5.99");
    expect(out).toContain('val FEATURES: List<String> = listOf("themes", "sync")');
    expect(out).toContain("val RATIOS: List<Double> = listOf(1.0, 2.5)");
    expect(out).toContain("const val BIG: Long = 3000000000L");
    expect(out).toContain("const val TRIAL: Boolean = true");
    expect(out).toContain("val NOTHING: String? = null");
    expect(out).toContain('const val CLOUD_STORAGE: String = "5GB"');
  });

  it("escapes Kotlin string literals including $ templates", () => {
    expect(kotlinString(tricky)).toBe('"Say \\"hi\\" \\\\ path\\nnew line \\$name \\\\(x) caf\\u00E9 \\uD83D\\uDE80"');
  });

  it("rejects invalid package names", () => {
    expect(() => generateCode(graph(), { lang: "kotlin", out: "F.kt", package: "com.1bad" })).toThrow(/invalid Kotlin package/);
  });
});

describe("writeCodegen", () => {
  it("writes every configured target and skips unchanged files", () => {
    const root = tmp();
    mkdirSync(join(root, ".starchart"));
    const targets = [
      { lang: "ts", out: "web/src/facts.ts" },
      { lang: "swift", out: "ios/Facts.swift" },
    ];
    const l = loaded(root, targets);
    const project: Project = { root, loaded: l, graph: compileProject(l).graph, lock: emptyLock(), warnings: [] };
    const first = writeCodegen(project);
    expect(first.files).toEqual(["web/src/facts.ts", "ios/Facts.swift"]);
    expect(first.changed).toEqual(first.files);
    expect(readFileSync(join(root, "web/src/facts.ts"), "utf8")).toContain("ADDON_PRO");
    expect(writeCodegen(project).changed).toEqual([]);
  });
});
