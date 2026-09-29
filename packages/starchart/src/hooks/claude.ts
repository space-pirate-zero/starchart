import { dirname, isAbsolute, relative, resolve } from "node:path";
import { planFromLock, planFromSeeds, resolveRef, type Plan } from "../api.js";
import { findRoot, STARCHART_DIR } from "../config/load.js";
import type { ImpactClass, ImpactHop, ImpactItem } from "../core/impact.js";
import { buildProject, type Project } from "../project.js";
import { CLASS_LABEL, CLASS_SYMBOL } from "../format/plan.js";

/**
 * Claude Code `PostToolUse` hook: after an agent edits a file, inject the file's cross-layer
 * blast radius into the agent's context. Hooks must never break the agent, so every failure
 * yields empty output (details only with STARCHART_HOOK_DEBUG=1).
 */

export const HOOK_CONTEXT_LIMIT = 1500;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Class priority for the agent: what breaks first, informational last. */
const PRIORITY: readonly ImpactClass[] = ["break", "manual", "auto", "review", "code", "retire", "test", "info"];

interface HookEvent {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown; notebook_path?: unknown };
  cwd?: string;
}

export interface ClaudeHookOptions {
  cwd?: string;
  /** Injected for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Handles one hook invocation. `input` is the hook's stdin JSON. Returns the stdout payload:
 * `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}` or "".
 */
export async function runClaudeHook(input: string, opts: ClaudeHookOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  try {
    const context = await hookContext(input, opts.cwd);
    return context ? output(context) : "";
  } catch (error) {
    if (env.STARCHART_HOOK_DEBUG === "1") {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      return output(truncate(`STARCHART hook error (debug): ${message}`, HOOK_CONTEXT_LIMIT));
    }
    return "";
  }
}

function output(additionalContext: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } });
}

async function hookContext(input: string, cwdOption?: string): Promise<string | undefined> {
  if (!input.trim()) return undefined;
  const event = JSON.parse(input) as HookEvent;
  if (event.hook_event_name !== undefined && event.hook_event_name !== "PostToolUse") return undefined;
  if (!event.tool_name || !EDIT_TOOLS.has(event.tool_name)) return undefined;
  const rawPath = event.tool_input?.file_path ?? event.tool_input?.notebook_path;
  if (typeof rawPath !== "string" || !rawPath) return undefined;

  const cwd = event.cwd ?? cwdOption ?? process.cwd();
  const file = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const root = findRoot(dirname(file)) ?? findRoot(cwd);
  if (!root) return undefined;
  const rel = relative(root, file).split("\\").join("/");
  if (!rel || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return undefined;

  const project = await buildProject(root);

  // Editing the chart itself (facts / artifacts YAML): report everything that changed since the lock.
  if (rel === STARCHART_DIR || rel.startsWith(`${STARCHART_DIR}/`)) {
    const plan = planFromLock(project);
    return describePlan(plan, `STARCHART: fact edits in ${rel} (vs starchart.lock) impact`, rel, "`starchart plan`");
  }

  const seeds = new Set(resolveRef(project, file, root).filter((id) => fileScoped(project, id)));
  const boundArtifacts = artifactsBoundTo(project, rel);
  for (const id of boundArtifacts) seeds.add(id);
  if (seeds.size === 0) return undefined;

  const plan = planFromSeeds(project, [...seeds].map((id) => ({ id })));
  const header = [`STARCHART: editing ${rel}`];
  if (boundArtifacts.length) {
    const facts = boundArtifacts.flatMap((id) =>
      project.graph.outgoing(id).filter((e) => e.type === "embeds" || e.type === "renders").map((e) => e.to),
    );
    const managed = facts.length ? ` It carries facts ${unique(facts).slice(0, 6).join(", ")}; change the facts in .starchart/ rather than hand-editing values.` : "";
    header.push(`(world artifact ${boundArtifacts.join(", ")}).${managed}`);
  }
  const text = describePlan(plan, `${header.join(" ")} Impacts`, rel, `\`starchart impact ${rel}\``);
  if (text) return text;
  // An artifact with no downstream impact still deserves the "managed values" note.
  if (boundArtifacts.length) return truncate(header.join(" "), HOOK_CONTEXT_LIMIT);
  return undefined;
}

/** resolveRef falls back to suffix matching; only keep ids that really belong to this file. */
function fileScoped(project: Project, id: string): boolean {
  const kind = project.graph.node(id)?.kind;
  return kind !== undefined && kind !== "fact" && kind !== "entity" && kind !== "artifact";
}

function artifactsBoundTo(project: Project, rel: string): string[] {
  const out: string[] = [];
  for (const node of project.graph.nodes({ kind: "artifact" })) {
    const b = node.binding;
    if (!b) continue;
    const candidates = [b.path, b.file].filter((v): v is string => typeof v === "string");
    if (candidates.some((p) => normalize(p) === rel)) out.push(node.id);
  }
  return out.sort();
}

const normalize = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** Items that matter beyond code: world artifacts, facts reached across a bridge, and anchored constants. */
function relevant(item: ImpactItem): boolean {
  if (item.node.layer === "world") return true;
  if (item.via === "anchors") return true;
  return false;
}

function describePlan(plan: Plan, lead: string, rel: string, command: string): string | undefined {
  const items = plan.impact.items.filter(relevant);
  if (items.length === 0) return undefined;
  const rank = (c: ImpactClass) => PRIORITY.indexOf(c);
  items.sort((a, b) => rank(a.class) - rank(b.class) || a.depth - b.depth || a.id.localeCompare(b.id));

  const counts = PRIORITY.filter((c) => items.some((i) => i.class === c))
    .map((c) => `${items.filter((i) => i.class === c).length} ${CLASS_LABEL[c]}`)
    .join(", ");
  const head = `${lead} ${items.length} item${items.length === 1 ? "" : "s"} beyond code (${counts}):`;
  const footer = command.includes("starchart plan")
    ? `Run ${command} for the full blast radius.`
    : `Run ${command} (or \`starchart plan\`) for the full blast radius.`;
  const tests = plan.impact.items.filter((i) => i.class === "test").map((i) => i.id);
  const testLine = tests.length ? `Tests to run: ${tests.slice(0, 5).join(", ")}${tests.length > 5 ? ", …" : ""}` : "";

  const budget = HOOK_CONTEXT_LIMIT - head.length - footer.length - (testLine ? testLine.length + 1 : 0) - 40;
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const item of items) {
    const line = `${CLASS_SYMBOL[item.class]} ${CLASS_LABEL[item.class]} ${item.id} — ${item.reason} (${shortPath(item.path, rel)})`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < items.length) lines.push(`…and ${items.length - shown} more.`);
  const parts = [head, ...lines];
  if (testLine) parts.push(testLine);
  parts.push(footer);
  return truncate(parts.join("\n"), HOOK_CONTEXT_LIMIT);
}

/** `file → edge → … → edge → target`, eliding the middle of long paths. */
export function shortPath(path: readonly ImpactHop[], rel?: string): string {
  if (path.length === 0) return "";
  const label = (id: string) => (rel && (id === `file:${rel}` || id.endsWith(`/${rel}`)) ? rel.split("/").pop()! : shortId(id));
  const hop = (h: ImpactHop) => `-${h.type}→ ${label(h.to)}`;
  const first = path[0]!;
  if (path.length <= 3) return [label(first.from), ...path.map(hop)].join(" ");
  return [label(first.from), hop(first), "…", hop(path[path.length - 1]!)].join(" ");
}

const shortId = (id: string) => (id.length > 60 ? `…${id.slice(-59)}` : id);

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const unique = <T>(xs: T[]) => [...new Set(xs)];

/** The snippet users add to `.claude/settings.json`. */
export function claudeHookSettingsSnippet(): {
  hooks: { PostToolUse: { matcher: string; hooks: { type: "command"; command: string }[] }[] };
} {
  return {
    hooks: {
      PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: "npx starchart hook claude" }] }],
    },
  };
}

/** CLI entry: reads the hook event from stdin and writes the payload (if any) to stdout. Always exits cleanly. */
export async function claudeHookMain(stdin: NodeJS.ReadableStream = process.stdin): Promise<void> {
  let input = "";
  try {
    for await (const chunk of stdin) input += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  } catch {
    return;
  }
  const out = await runClaudeHook(input);
  if (out) process.stdout.write(`${out}\n`);
}
