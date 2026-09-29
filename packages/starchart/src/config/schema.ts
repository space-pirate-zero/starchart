import { z } from "zod";

const stringOrList = z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : [v]));

export const CodegenTarget = z.object({
  lang: z.enum(["ts", "swift", "kotlin"]),
  out: z.string(),
  /** Only emit facts under these entity ids (default: all). */
  entities: z.array(z.string()).optional(),
  /** Swift enum / Kotlin object name. */
  name: z.string().optional(),
  /** Kotlin package. */
  package: z.string().optional(),
});
export type CodegenTarget = z.infer<typeof CodegenTarget>;

export const CodeConfig = z.object({
  /** Scope name -> directory relative to the project root. Scope names prefix code node ids. */
  scopes: z.record(z.string(), z.string()).default({ app: "." }),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).default([]),
  /** Consecutive code hops traversed during impact analysis. */
  maxCodeDepth: z.number().int().positive().optional(),
});
export type CodeConfig = z.infer<typeof CodeConfig>;

export const ProjectConfig = z.object({
  name: z.string().default("starchart"),
  code: CodeConfig.default({ scopes: { app: "." }, exclude: [] }),
  adapters: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  packs: z.array(z.string()).default(["core"]),
  /** DTCG design tokens file(s) imported as facts under `token:`. */
  tokens: stringOrList.optional(),
  codegen: z.array(CodegenTarget).default([]),
  /** Content roots scanned for unbound fact literals (default: code scopes). */
  content: z.array(z.string()).optional(),
  /** Base URL used by the url adapter for relative bindings. */
  site: z.string().optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

export const FactSpec = z.object({
  value: z.unknown().optional(),
  authority: z.string().optional(),
  source: z.record(z.string(), z.unknown()).optional(),
  description: z.string().optional(),
});

export const EntityDoc = z.object({
  id: z.string(),
  kind: z.literal("entity").optional(),
  type: stringOrList.optional(),
  label: z.string().optional(),
  of: z.string().optional(),
  status: z.string().optional(),
  owners: z.array(z.string()).optional(),
  validThrough: z.string().optional(),
  tags: z.array(z.string()).optional(),
  facts: z.record(z.string(), z.unknown()).default({}),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type EntityDoc = z.infer<typeof EntityDoc>;

export const RendersSpec = z.union([
  z.string(),
  z.array(z.string()),
  z.object({ template: z.string(), with: stringOrList, out: z.string().optional() }),
]);

export const ArtifactDoc = z.object({
  id: z.string(),
  kind: z.literal("artifact").optional(),
  type: stringOrList.optional(),
  label: z.string().optional(),
  binding: z.object({ adapter: z.string() }).catchall(z.unknown()).optional(),
  owners: z.array(z.string()).optional(),
  status: z.string().optional(),
  validThrough: z.string().optional(),
  tags: z.array(z.string()).optional(),
  embeds: stringOrList.optional(),
  renders: RendersSpec.optional(),
  describes: stringOrList.optional(),
  promotes: stringOrList.optional(),
  mirrors: stringOrList.optional(),
  derivedFrom: stringOrList.optional(),
  captures: stringOrList.optional(),
  after: stringOrList.optional(),
  blocks: stringOrList.optional(),
  /** Route(s) that publish this artifact: adds `route --publishes--> artifact`. */
  publishedBy: stringOrList.optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type ArtifactDoc = z.infer<typeof ArtifactDoc>;

export const EdgeDoc = z.object({
  from: z.string(),
  to: z.string(),
  type: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});
export type EdgeDoc = z.infer<typeof EdgeDoc>;

/** Rule documents are validated by the rules engine; kept loose here. */
export const RuleDoc = z.record(z.string(), z.unknown());
