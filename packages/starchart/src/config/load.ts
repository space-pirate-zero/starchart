import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import fg from "fast-glob";
import { parseAllDocuments } from "yaml";
import { ArtifactDoc, EdgeDoc, EntityDoc, ProjectConfig } from "./schema.js";

export const STARCHART_DIR = ".starchart";
export const LOCK_FILE = "starchart.lock";

export interface LoadedProject {
  root: string;
  config: ProjectConfig;
  entities: (EntityDoc & { file: string })[];
  artifacts: (ArtifactDoc & { file: string })[];
  edges: (EdgeDoc & { file: string })[];
  rules: (Record<string, unknown> & { file: string })[];
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
    this.name = "ConfigError";
  }
}

/** Walks up from `start` to the nearest directory containing `.starchart/`. */
export function findRoot(start = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, STARCHART_DIR))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Loads config and every YAML document under `.starchart/`. */
export function loadProject(root: string): LoadedProject {
  const dir = join(root, STARCHART_DIR);
  if (!existsSync(dir)) throw new ConfigError(`no ${STARCHART_DIR}/ directory in ${root}. Run "starchart init".`);

  const configPath = ["config.yaml", "config.yml"].map((f) => join(dir, f)).find(existsSync);
  const rawConfig = configPath ? parseSingle(configPath) : {};
  const parsedConfig = ProjectConfig.safeParse(rawConfig ?? {});
  if (!parsedConfig.success) throw new ConfigError(formatZod(parsedConfig.error), configPath && relative(root, configPath));

  const project: LoadedProject = { root, config: parsedConfig.data, entities: [], artifacts: [], edges: [], rules: [] };
  const files = fg.sync(["**/*.yaml", "**/*.yml"], { cwd: dir, ignore: ["config.yaml", "config.yml", "preview/**", "journal/**"] }).sort();

  for (const file of files) {
    const path = join(dir, file);
    const label = rel(root, path);
    for (const doc of parseAll(path)) collect(project, doc, label);
  }
  return project;
}

function collect(project: LoadedProject, doc: unknown, file: string): void {
  if (doc == null) return;
  if (Array.isArray(doc)) {
    for (const d of doc) collect(project, d, file);
    return;
  }
  if (typeof doc !== "object") throw new ConfigError("expected a mapping or a list", file);
  const obj = doc as Record<string, unknown>;

  const sections = ["entities", "artifacts", "edges", "rules"] as const;
  if (sections.some((s) => s in obj)) {
    for (const d of asList(obj.entities)) pushEntity(project, d, file);
    for (const d of asList(obj.artifacts)) pushArtifact(project, d, file);
    for (const d of asList(obj.edges)) {
      const r = EdgeDoc.safeParse(d);
      if (!r.success) throw new ConfigError(formatZod(r.error), file);
      project.edges.push({ ...r.data, file });
    }
    for (const d of asList(obj.rules)) {
      if (!d || typeof d !== "object") throw new ConfigError("rule must be a mapping", file);
      project.rules.push({ ...(d as Record<string, unknown>), file });
    }
    return;
  }
  if (obj.kind === "entity" || "facts" in obj) pushEntity(project, obj, file);
  else pushArtifact(project, obj, file);
}

function pushEntity(project: LoadedProject, d: unknown, file: string) {
  const r = EntityDoc.safeParse(d);
  if (!r.success) throw new ConfigError(formatZod(r.error), file);
  project.entities.push({ ...r.data, file });
}

function pushArtifact(project: LoadedProject, d: unknown, file: string) {
  const r = ArtifactDoc.safeParse(d);
  if (!r.success) throw new ConfigError(formatZod(r.error), file);
  project.artifacts.push({ ...r.data, file });
}

const asList = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function parseAll(path: string): unknown[] {
  const docs = parseAllDocuments(readFileSync(path, "utf8"));
  const out: unknown[] = [];
  for (const d of Array.isArray(docs) ? docs : [docs]) {
    if (d.errors.length) throw new ConfigError(d.errors[0]!.message, path);
    out.push(d.toJS());
  }
  return out;
}

function parseSingle(path: string): unknown {
  return parseAll(path)[0];
}

const rel = (root: string, path: string) => relative(root, path);

function formatZod(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");
}
