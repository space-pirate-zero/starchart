import { z } from "zod";
import type { Graph } from "../core/graph.js";
import type { LockFile } from "../core/lock.js";
import { isEdgeType, type EdgeType, type GraphNode } from "../core/model.js";
import {
  ageInDays,
  charLength,
  deepEqual,
  descendantFacts,
  fileOf,
  formatValue,
  getPath,
  isExpired,
  isLocaleMap,
  matchIdOrPrefix,
  parseDate,
} from "./util.js";

/**
 * Declarative invariants over the graph ("ESLint for your business"), plus custom
 * function rules contributed by rule packs.
 */

export type Severity = "error" | "warn" | "info";

export interface Violation {
  rule: string;
  severity: Severity;
  node: string;
  message: string;
  pack?: string;
  file?: string;
}

/** What a custom rule returns: engine fills in rule id, severity, pack and file when omitted. */
export type Finding = Pick<Violation, "node" | "message"> & Partial<Omit<Violation, "node" | "message">>;

export interface RuleContext {
  now: Date;
  lock?: LockFile;
  /** Project root; rules that read files (e.g. privacy manifests) need it. */
  root?: string;
  /** Per-evaluation memo shared by all rules (e.g. parsed manifests). */
  cache: Map<string, unknown>;
  rule: { id: string; severity: Severity; pack?: string };
}

export interface Selector {
  kind?: string[];
  type?: string[];
  prefix?: string[];
  tag?: string[];
  adapter?: string[];
  where?: Record<string, unknown>;
  whereNot?: Record<string, unknown>;
}

export interface EdgeRequirement {
  type: EdgeType;
  direction: "in" | "out";
  min: number;
  max?: number;
  adapter?: string;
  to?: string;
  /** For incoming edges on an entity: also count edges into its facts. Defaults to true for entities. */
  via?: boolean;
}

export type LocaleSelection = "all" | string[];

export interface ValueConstraint {
  fact?: string;
  required?: boolean;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  equals?: unknown;
  oneOf?: unknown[];
  locales?: LocaleSelection;
}

export interface ReachableRequirement {
  from: string;
  edge: EdgeType;
  min: number;
}

export interface Requirements {
  edge?: EdgeRequirement[];
  bound?: boolean;
  notExpired?: boolean;
  maxAge?: { field: string; days: number };
  value?: ValueConstraint[];
  owners?: boolean;
  reachable?: ReachableRequirement[];
}

interface RuleBase {
  id: string;
  description?: string;
  severity: Severity;
  pack?: string;
  /** YAML file the rule was declared in. */
  file?: string;
}

export interface DeclarativeRule extends RuleBase {
  select: Selector;
  require: Requirements;
}

export interface CustomRule extends RuleBase {
  check: (graph: Graph, ctx: RuleContext) => Finding[];
}

export type Rule = DeclarativeRule | CustomRule;

export const isCustomRule = (rule: Rule): rule is CustomRule => typeof (rule as CustomRule).check === "function";

// ---------------------------------------------------------------------------------------------
// schema

/** Accepts a single item or a list; always yields a list (errors point at `field.<index>`). */
const list = <T extends z.ZodType>(item: T) => z.preprocess((v) => (v === undefined || Array.isArray(v) ? v : [v]), z.array(item));
const stringList = list(z.string().min(1));

const edgeType = z.string().refine(isEdgeType, { message: "unknown edge type" }).transform((v) => v as EdgeType);

const regex = z.string().refine(
  (p) => {
    try {
      new RegExp(p);
      return true;
    } catch {
      return false;
    }
  },
  { message: "invalid regular expression" },
);

const SelectorSchema = z.strictObject({
  kind: stringList.optional(),
  type: stringList.optional(),
  prefix: stringList.optional(),
  tag: stringList.optional(),
  adapter: stringList.optional(),
  where: z.record(z.string(), z.unknown()).optional(),
  whereNot: z.record(z.string(), z.unknown()).optional(),
});

const EdgeRequirementSchema = z
  .strictObject({
    type: edgeType,
    direction: z.enum(["in", "out"]).default("out"),
    min: z.number().int().nonnegative().default(1),
    max: z.number().int().nonnegative().optional(),
    adapter: z.string().optional(),
    to: z.string().optional(),
    via: z.union([z.boolean(), z.enum(["fact", "none"])]).optional(),
  })
  .refine((e) => e.max === undefined || e.max >= e.min, { message: "max must be >= min" })
  .transform((e): EdgeRequirement => {
    const out: EdgeRequirement = { type: e.type, direction: e.direction, min: e.min };
    if (e.max !== undefined) out.max = e.max;
    if (e.adapter !== undefined) out.adapter = e.adapter;
    if (e.to !== undefined) out.to = e.to;
    if (e.via !== undefined) out.via = e.via === true || e.via === "fact";
    return out;
  });

const ValueConstraintSchema = z
  .strictObject({
    fact: z.string().min(1).optional(),
    required: z.boolean().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    minLength: z.number().int().nonnegative().optional(),
    pattern: regex.optional(),
    equals: z.unknown().optional(),
    oneOf: z.array(z.unknown()).optional(),
    locales: z.union([z.literal("all"), z.array(z.string().min(1))]).optional(),
  })
  .refine(
    (v) =>
      v.required !== undefined ||
      v.maxLength !== undefined ||
      v.minLength !== undefined ||
      v.pattern !== undefined ||
      "equals" in v ||
      v.oneOf !== undefined,
    { message: "value needs at least one of maxLength, minLength, pattern, equals, oneOf, required" },
  );

const ReachableSchema = z.strictObject({
  from: z.string().min(1),
  edge: edgeType,
  min: z.number().int().positive().default(1),
});

const RequirementsSchema = z
  .strictObject({
    edge: list(EdgeRequirementSchema).optional(),
    bound: z.boolean().optional(),
    notExpired: z.boolean().optional(),
    maxAge: z.strictObject({ field: z.string().min(1), days: z.number().positive() }).optional(),
    value: list(ValueConstraintSchema).optional(),
    owners: z.boolean().optional(),
    reachable: list(ReachableSchema).optional(),
  })
  .refine((r) => Object.values(r).some((v) => v !== undefined && v !== false), { message: "require must list at least one predicate" });

export const RuleSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][\w.:/-]*$/, "rule id must be a slug (letters, digits, - _ . : /)"),
  description: z.string().optional(),
  severity: z.enum(["error", "warn", "info"]).default("error"),
  pack: z.string().optional(),
  file: z.string().optional(),
  select: SelectorSchema.default({}),
  require: RequirementsSchema,
});

/** Authoring shape for a declarative rule (YAML or TS), before defaults are applied. */
export type RuleInput = z.input<typeof RuleSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.map(String).join(".");
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join("; ");
}

function toDeclarative(data: z.output<typeof RuleSchema>): DeclarativeRule {
  const rule: DeclarativeRule = { id: data.id, severity: data.severity, select: stripUndefined(data.select), require: stripUndefined(data.require) };
  if (data.description !== undefined) rule.description = data.description;
  if (data.pack !== undefined) rule.pack = data.pack;
  if (data.file !== undefined) rule.file = data.file;
  return rule;
}

/**
 * Validates rule documents (YAML `rules:` entries carrying a `file` field, or TS objects).
 * Objects with a `check` function pass through as custom rules.
 */
export function parseRules(docs: unknown[]): { rules: Rule[]; errors: string[] } {
  const rules: Rule[] = [];
  const errors: string[] = [];
  const seen = new Map<string, string>();
  docs.forEach((doc, index) => {
    const obj = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
    const file = typeof obj?.file === "string" ? obj.file : undefined;
    const label = `${file ?? "rules"}: rule ${typeof obj?.id === "string" ? `"${obj.id}"` : `#${index + 1}`}`;
    if (!obj) {
      errors.push(`${label}: rule must be a mapping`);
      return;
    }
    let rule: Rule;
    if (typeof obj.check === "function") {
      if (typeof obj.id !== "string" || !obj.id) {
        errors.push(`${label}: custom rule needs an id`);
        return;
      }
      const severity = obj.severity ?? "error";
      if (severity !== "error" && severity !== "warn" && severity !== "info") {
        errors.push(`${label}: severity must be error, warn or info`);
        return;
      }
      rule = obj.severity === undefined ? { ...(obj as unknown as CustomRule), severity } : (obj as unknown as CustomRule);
    } else {
      const parsed = RuleSchema.safeParse(obj);
      if (!parsed.success) {
        errors.push(`${label}: ${formatIssues(parsed.error)}`);
        return;
      }
      rule = toDeclarative(parsed.data);
    }
    const previous = seen.get(rule.id);
    if (previous !== undefined) {
      errors.push(`${label}: duplicate rule id (first declared in ${previous})`);
      return;
    }
    seen.set(rule.id, file ?? "rules");
    rules.push(rule);
  });
  return { rules, errors };
}

/** Parses one declarative rule, throwing on invalid input. For rule packs written in TS. */
export function defineRule(input: RuleInput): DeclarativeRule {
  const parsed = RuleSchema.safeParse(input);
  if (!parsed.success) throw new Error(`invalid rule ${String(input.id)}: ${formatIssues(parsed.error)}`);
  return toDeclarative(parsed.data);
}

// ---------------------------------------------------------------------------------------------
// evaluation

export interface EvaluateOptions {
  now?: Date;
  lock?: LockFile;
  root?: string;
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export function compareViolations(a: Violation, b: Violation): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.rule.localeCompare(b.rule) ||
    a.node.localeCompare(b.node) ||
    a.message.localeCompare(b.message)
  );
}

/** Runs every rule and returns violations sorted by severity, then rule, then node. */
export function evaluateRules(graph: Graph, rules: Rule[], opts: EvaluateOptions = {}): Violation[] {
  const now = opts.now ?? new Date();
  const cache = new Map<string, unknown>();
  const out: Violation[] = [];
  for (const rule of rules) {
    const ctx: RuleContext = { now, lock: opts.lock, root: opts.root, cache, rule: { id: rule.id, severity: rule.severity, pack: rule.pack } };
    const findings = isCustomRule(rule) ? rule.check(graph, ctx) : evaluateDeclarative(graph, rule, now);
    for (const f of findings) {
      const v: Violation = { rule: f.rule ?? rule.id, severity: f.severity ?? rule.severity, node: f.node, message: f.message };
      const pack = f.pack ?? rule.pack;
      if (pack !== undefined) v.pack = pack;
      const file = f.file ?? fileOf(graph.node(f.node)) ?? rule.file;
      if (file !== undefined) v.file = file;
      out.push(v);
    }
  }
  return dedupe(out).sort(compareViolations);
}

function dedupe(vs: Violation[]): Violation[] {
  const seen = new Set<string>();
  return vs.filter((v) => {
    const key = `${v.rule}\u0000${v.node}\u0000${v.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Nodes a selector picks, sorted by id. */
export function selectNodes(graph: Graph, select: Selector): GraphNode[] {
  return graph
    .nodes()
    .filter((n) => matchesSelector(n, select))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function matchesSelector(node: GraphNode, s: Selector): boolean {
  if (s.kind && !s.kind.includes(node.kind)) return false;
  if (s.type && !s.type.some((t) => node.types?.includes(t))) return false;
  if (s.prefix && !s.prefix.some((p) => node.id.startsWith(p))) return false;
  if (s.tag && !s.tag.some((t) => node.tags?.includes(t))) return false;
  if (s.adapter && !(node.binding && s.adapter.includes(node.binding.adapter))) return false;
  if (s.where && !Object.entries(s.where).every(([path, expected]) => fieldMatches(getPath(node, path), expected))) return false;
  if (s.whereNot && Object.entries(s.whereNot).some(([path, expected]) => fieldMatches(getPath(node, path), expected))) return false;
  return true;
}

/** Equality; a list on the rule side means "any of", unless the node field is itself a list. */
function fieldMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected) && !Array.isArray(actual)) return expected.some((e) => deepEqual(actual, e));
  if (Array.isArray(actual) && !Array.isArray(expected)) return actual.some((a) => deepEqual(a, expected));
  return deepEqual(actual, expected);
}

function evaluateDeclarative(graph: Graph, rule: DeclarativeRule, now: Date): Finding[] {
  const findings: Finding[] = [];
  const r = rule.require;
  for (const node of selectNodes(graph, rule.select)) {
    const push = (message: string) => findings.push({ node: node.id, message });
    if (r.bound && !node.binding) push(`${node.id} has no binding`);
    if (r.owners && !(node.owners && node.owners.length > 0)) push(`${node.id} has no owners`);
    if (r.notExpired && isExpired(node, now)) push(`${node.id} expired on ${node.validThrough}`);
    if (r.maxAge) {
      const raw = getPath(node, r.maxAge.field);
      const t = parseDate(raw);
      if (t === undefined) push(`${node.id} has no valid ${r.maxAge.field} (maxAge ${r.maxAge.days}d)`);
      else {
        const age = ageInDays(t, now);
        if (age > r.maxAge.days) push(`${node.id} ${r.maxAge.field} is ${age} days old (max ${r.maxAge.days})`);
      }
    }
    for (const req of r.edge ?? []) {
      const message = checkEdge(graph, node, req);
      if (message) push(message);
    }
    for (const req of r.reachable ?? []) {
      const count = new Set(graph.incoming(node.id, req.edge).filter((e) => matchIdOrPrefix(req.from, e.from) && graph.hasNode(e.from)).map((e) => e.from)).size;
      if (count < req.min) push(`${node.id} is reached by ${count} ${req.from} node(s) via ${req.edge} (min ${req.min})`);
    }
    for (const c of r.value ?? []) {
      const subject = c.fact ? `${node.id} ${c.fact}` : node.id;
      const target = c.fact ? graph.node(`${node.id}.${c.fact}`) : node;
      for (const m of checkValue(target?.value, c, subject)) push(m);
    }
  }
  return findings;
}

function describeEdge(req: EdgeRequirement): string {
  const dir = req.direction === "in" ? "incoming" : "outgoing";
  const parts = [`${dir} ${req.type}`];
  const prep = req.direction === "in" ? "from" : "to";
  if (req.adapter) parts.push(`${prep} ${/^[aeiou]/i.test(req.adapter) ? "an" : "a"} ${req.adapter} artifact`);
  if (req.to) parts.push(`${req.adapter ? "matching" : prep} ${req.to}`);
  return parts.join(" ");
}

function checkEdge(graph: Graph, node: GraphNode, req: EdgeRequirement): string | undefined {
  const viaFacts = req.direction === "in" && (req.via ?? node.kind === "entity");
  const targets = viaFacts ? [node.id, ...descendantFacts(graph, node.id)] : [node.id];
  const others = new Set<string>();
  for (const id of targets) {
    const edges = req.direction === "in" ? graph.incoming(id, req.type) : graph.outgoing(id, req.type);
    for (const e of edges) {
      const other = req.direction === "in" ? e.from : e.to;
      if (req.to && !matchIdOrPrefix(req.to, other)) continue;
      if (req.adapter) {
        const o = graph.node(other);
        if (o?.kind !== "artifact" || o.binding?.adapter !== req.adapter) continue;
      }
      others.add(other);
    }
  }
  const count = others.size;
  if (count < req.min) return `${node.id} has ${count} ${describeEdge(req)} (min ${req.min})`;
  if (req.max !== undefined && count > req.max) {
    return `${node.id} has ${count} ${describeEdge(req)} (max ${req.max}): ${[...others].sort().join(", ")}`;
  }
  return undefined;
}

/**
 * Checks a value against a constraint. A `{locale: text}` map is checked per locale;
 * `locales` narrows (or with a list, requires) the locales. Returns human messages.
 */
export function checkValue(value: unknown, c: ValueConstraint, subject: string): string[] {
  if (value === undefined || value === null) return c.required ? [`${subject} has no value`] : [];
  const perLocale = isLocaleMap(value) && (c.locales !== undefined || !("equals" in c) || !isLocaleMap(c.equals));
  if (!perLocale) return checkScalar(value, c, subject);
  const map = value;
  const out: string[] = [];
  const locales = c.locales === undefined || c.locales === "all" ? Object.keys(map).sort() : c.locales;
  for (const locale of locales) {
    const v = map[locale];
    if (v === undefined) {
      out.push(`${subject} is missing locale ${locale}`);
      continue;
    }
    out.push(...checkScalar(v, c, `${subject} [${locale}]`));
  }
  return out;
}

function checkScalar(value: unknown, c: ValueConstraint, subject: string): string[] {
  const out: string[] = [];
  if (c.maxLength !== undefined || c.minLength !== undefined) {
    if (typeof value !== "string") out.push(`${subject} is ${formatValue(value)}, expected text`);
    else {
      const len = charLength(value);
      if (c.maxLength !== undefined && len > c.maxLength) out.push(`${subject} ${formatValue(value)} is ${len} chars (max ${c.maxLength})`);
      if (c.minLength !== undefined && len < c.minLength) out.push(`${subject} ${formatValue(value)} is ${len} chars (min ${c.minLength})`);
    }
  }
  if (c.pattern !== undefined) {
    const text = typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value);
    if (!new RegExp(c.pattern).test(text)) out.push(`${subject} ${formatValue(value)} does not match /${c.pattern}/`);
  }
  if ("equals" in c && c.equals !== undefined && !deepEqual(value, c.equals)) {
    out.push(`${subject} is ${formatValue(value)}, expected ${formatValue(c.equals)}`);
  }
  if (c.oneOf !== undefined && !c.oneOf.some((o) => deepEqual(value, o))) {
    out.push(`${subject} is ${formatValue(value)}, expected one of ${c.oneOf.map((o) => formatValue(o)).join(", ")}`);
  }
  return out;
}

function stripUndefined<T extends object>(obj: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** A named, shareable set of rules (e.g. `core`, `appstore`, `privacy`). */
export interface RulePack {
  id: string;
  description: string;
  rules: Rule[];
}
