import { resolveInRoot } from "../paths.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { CodegenTarget } from "../config/schema.js";
import type { Graph } from "../core/graph.js";
import type { Project } from "../project.js";
import { generateKotlin } from "./kotlin.js";
import { generateSwift } from "./swift.js";
import { generateTypeScript } from "./typescript.js";

export { GENERATED_MARKER } from "./tree.js";
export { generateKotlin, kotlinString } from "./kotlin.js";
export { generateSwift, swiftString } from "./swift.js";
export { generateTypeScript, tsLiteral } from "./typescript.js";

/** Facts as code: renders one codegen target to source text. Output is deterministic. */
export function generateCode(graph: Graph, target: CodegenTarget): string {
  switch (target.lang) {
    case "ts":
      return generateTypeScript(graph, target.entities);
    case "swift":
      return generateSwift(graph, target.name, target.entities);
    case "kotlin":
      return generateKotlin(graph, target.name, target.package, target.entities);
  }
}

export interface CodegenResult {
  /** Every target file (relative to the project root). */
  files: string[];
  /** Files whose content changed on this run. */
  changed: string[];
}

/** Writes every `codegen` target from the project config. Unchanged files are not rewritten. */
export function writeCodegen(project: Project): CodegenResult {
  const files: string[] = [];
  const changed: string[] = [];
  for (const target of project.loaded.config.codegen) {
    const path = resolveInRoot(project.root, target.out);
    const rel = relative(project.root, path).split("\\").join("/");
    const source = generateCode(project.graph, target);
    files.push(rel);
    if (existsSync(path) && readFileSync(path, "utf8") === source) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
    changed.push(rel);
  }
  return { files, changed };
}
