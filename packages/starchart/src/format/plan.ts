import pc from "picocolors";
import type { Plan } from "../api.js";
import { explainPath, type ImpactClass, type ImpactItem } from "../core/impact.js";
import type { StaleArtifact } from "../core/lock.js";

/**
 * Shared renderings of a {@link Plan}: Terraform-style terminal text, GitHub-flavoured
 * markdown for PR comments and agent context, and a stable JSON structure.
 */

/** Display order: the most urgent classes first. */
export const CLASS_ORDER: readonly ImpactClass[] = ["break", "manual", "auto", "review", "code", "retire", "test", "info"];

export const CLASS_SYMBOL: Record<ImpactClass, string> = {
  auto: "~",
  review: "?",
  manual: "!",
  retire: "✗",
  break: "✗",
  code: "⌘",
  test: "✓",
  info: "·",
};

export const CLASS_LABEL: Record<ImpactClass, string> = {
  auto: "auto",
  review: "review",
  manual: "manual",
  retire: "retire",
  break: "break",
  code: "code",
  test: "tests",
  info: "info",
};

const CLASS_TITLE: Record<ImpactClass, string> = {
  break: "Broken",
  manual: "Manual",
  auto: "Auto-fixable",
  review: "Needs review",
  code: "Code to update",
  retire: "Retire",
  test: "Tests to run",
  info: "Informational",
};

type Paint = (s: string) => string;

const ORANGE_OPEN = "\u001b[38;5;208m";
const ORANGE_CLOSE = "\u001b[39m";

function palette(enabled: boolean): Record<ImpactClass, Paint> & { dim: Paint; bold: Paint } {
  const c = pc.createColors(enabled);
  const orange: Paint = enabled ? (s) => `${ORANGE_OPEN}${s}${ORANGE_CLOSE}` : (s) => s;
  return {
    auto: c.green,
    review: c.yellow,
    manual: orange,
    retire: c.gray,
    break: c.red,
    code: c.cyan,
    test: c.magenta,
    info: c.dim,
    dim: c.dim,
    bold: c.bold,
  };
}

/** Compact one-line rendering of a fact or hash value. */
export function formatValue(value: unknown, max = 60): string {
  if (value === undefined) return "∅";
  const text = JSON.stringify(value) ?? String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Items sorted by class urgency, then depth, then id. */
export function sortItems(items: readonly ImpactItem[]): ImpactItem[] {
  const rank = (c: ImpactClass) => CLASS_ORDER.indexOf(c);
  return [...items].sort((a, b) => rank(a.class) - rank(b.class) || a.depth - b.depth || a.id.localeCompare(b.id));
}

function changeHeader(change: Plan["changes"][number]): string {
  if (change.before === undefined && change.after === undefined) return `Change: ${change.id}`;
  return `Change: ${change.id}  ${formatValue(change.before)} → ${formatValue(change.after)}`;
}

function summaryParts(summary: Plan["summary"], includeInfo: boolean): string[] {
  const parts: string[] = [];
  for (const cls of CLASS_ORDER) {
    if (cls === "info" && !includeInfo) continue;
    const n = summary[cls];
    if (n > 0) parts.push(`${n} ${CLASS_LABEL[cls]}`);
  }
  return parts;
}

export interface TextOptions {
  color?: boolean;
  /** Also list informational items and print why-paths and confidence. */
  verbose?: boolean;
}

/** Terraform-style plan for terminals. */
export function formatPlanText(plan: Plan, opts: TextOptions = {}): string {
  const paint = palette(opts.color ?? false);
  const lines: string[] = [];
  if (plan.changes.length === 0) {
    lines.push(paint.dim("No changes."));
  } else {
    for (const change of plan.changes) lines.push(paint.bold(changeHeader(change)));
  }

  const visible = sortItems(plan.impact.items).filter((i) => opts.verbose || i.class !== "info");
  const hiddenInfo = plan.impact.items.length - visible.length;
  if (visible.length) {
    lines.push("");
    const labelWidth = Math.max(...visible.map((i) => CLASS_LABEL[i.class].length));
    const idWidth = Math.min(56, Math.max(...visible.map((i) => i.id.length)));
    const viaWidth = Math.max(...visible.map((i) => i.via.length));
    for (const item of visible) {
      const color = paint[item.class];
      const head = color(`${CLASS_SYMBOL[item.class]} ${CLASS_LABEL[item.class].padEnd(labelWidth)}`);
      const row = `  ${head}  ${item.id.padEnd(idWidth)}  ${paint.dim(item.via.padEnd(viaWidth))}  ${item.reason}`;
      lines.push(row.trimEnd());
      if (opts.verbose) {
        lines.push(paint.dim(`      why: ${explainPath(item.path)}  (confidence ${item.confidence})`));
      }
    }
  }

  if (plan.steps.length) {
    lines.push("");
    lines.push(`${paint.bold("Order:")} ${plan.steps.map((s) => s.item.id).join(" → ")}`);
  }
  for (const cycle of plan.cycles) lines.push(paint.review(`Cycle broken deterministically: ${cycle.join(", ")}`));

  lines.push("");
  const parts = summaryParts(plan.summary, opts.verbose ?? false);
  if (parts.length === 0) lines.push(paint.dim("No cross-layer impact."));
  else lines.push(`${paint.bold("Plan:")} ${parts.join(" · ")}`);
  if (hiddenInfo > 0) lines.push(paint.dim(`(${hiddenInfo} informational item${hiddenInfo === 1 ? "" : "s"} hidden; use --verbose)`));
  return `${lines.join("\n")}\n`;
}

/** Escapes text for a markdown table cell. */
function cell(text: string): string {
  return escapeHtml(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline code span that survives arbitrary backticks. */
function code(text: string): string {
  const ticks = text.match(/`+/g)?.reduce((m, t) => Math.max(m, t.length), 0) ?? 0;
  const fence = "`".repeat(ticks + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Code span safe inside a GFM table cell. */
const codeCell = (text: string) => code(text.replace(/\|/g, "\\|"));

export interface MarkdownOptions {
  title?: string;
  /** Rows per class section before truncation (default 50). */
  maxItems?: number;
  /** Include informational items (default false). */
  includeInfo?: boolean;
}

/** Markdown for PR comments and agent context. */
export function formatPlanMarkdown(plan: Plan, opts: MarkdownOptions = {}): string {
  const maxItems = opts.maxItems ?? 50;
  const out: string[] = [`## ${opts.title ?? "🌌 STARCHART blast radius"}`, ""];

  if (plan.changes.length === 0) {
    out.push("No changes detected.", "");
  } else {
    out.push(`**${plan.changes.length} change${plan.changes.length === 1 ? "" : "s"}:**`, "");
    for (const change of plan.changes.slice(0, maxItems)) {
      const values =
        change.before === undefined && change.after === undefined
          ? ""
          : ` ${code(formatValue(change.before))} → ${code(formatValue(change.after))}`;
      out.push(`- ${code(change.id)}${values}`);
    }
    if (plan.changes.length > maxItems) out.push(`- …and ${plan.changes.length - maxItems} more`);
    out.push("");
  }

  const classes = CLASS_ORDER.filter((c) => (c !== "info" || opts.includeInfo) && plan.summary[c] > 0);
  if (classes.length === 0) {
    out.push("✅ No cross-layer impact.", "");
  } else {
    out.push("| | Class | Count |", "|---|---|---:|");
    for (const cls of classes) out.push(`| ${CLASS_SYMBOL[cls]} | ${CLASS_TITLE[cls]} | ${plan.summary[cls]} |`);
    out.push("");

    const grouped = new Map<ImpactClass, ImpactItem[]>();
    for (const item of sortItems(plan.impact.items)) {
      const list = grouped.get(item.class) ?? [];
      list.push(item);
      grouped.set(item.class, list);
    }
    for (const cls of classes) {
      const items = grouped.get(cls) ?? [];
      const open = cls === "break" || cls === "manual" ? " open" : "";
      out.push(`<details${open}><summary><b>${CLASS_SYMBOL[cls]} ${CLASS_TITLE[cls]}</b> (${items.length})</summary>`, "");
      out.push("| Artifact | Via | Reason | Why |", "|---|---|---|---|");
      for (const item of items.slice(0, maxItems)) {
        out.push(
          `| ${codeCell(item.id)} | ${cell(item.via)} | ${cell(item.reason)} | <code>${cell(explainPath(item.path))}</code> |`,
        );
      }
      if (items.length > maxItems) out.push(`| …and ${items.length - maxItems} more | | | |`);
      out.push("", "</details>", "");
    }
  }

  if (plan.steps.length) {
    out.push("### Rollout order", "");
    plan.steps.forEach((step, index) => {
      const waits = step.waitsFor.length ? ` — after ${step.waitsFor.map(code).join(", ")}` : "";
      out.push(`${index + 1}. ${code(step.item.id)} (${CLASS_LABEL[step.item.class]})${waits}`);
    });
    out.push("");
  }
  if (plan.cycles.length) {
    for (const cycle of plan.cycles) out.push(`> ⚠️ Ordering cycle broken deterministically: ${cycle.map(code).join(", ")}`);
    out.push("");
  }

  out.push("---", "<sub>Charted by <b>STARCHART</b> · run <code>starchart plan</code> locally for details</sub>", "");
  return out.join("\n");
}

export interface PlanJson {
  changes: { id: string; before?: unknown; after?: unknown }[];
  items: {
    id: string;
    class: ImpactClass;
    layer: string;
    kind: string;
    via: string;
    reason: string;
    confidence: number;
    depth: number;
    why: string;
    path: { from: string; to: string; type: string }[];
  }[];
  steps: { id: string; class: ImpactClass; waitsFor: string[] }[];
  cycles: string[][];
  summary: Plan["summary"];
}

/** Stable, JSON-safe plan structure (no graph node objects, deterministic ordering). */
export function formatPlanJson(plan: Plan): PlanJson {
  return {
    changes: plan.changes.map((c) => {
      const entry: PlanJson["changes"][number] = { id: c.id };
      if (c.before !== undefined) entry.before = jsonSafe(c.before);
      if (c.after !== undefined) entry.after = jsonSafe(c.after);
      return entry;
    }),
    items: sortItems(plan.impact.items).map((i) => ({
      id: i.id,
      class: i.class,
      layer: i.node.layer,
      kind: i.node.kind,
      via: i.via,
      reason: i.reason,
      confidence: i.confidence,
      depth: i.depth,
      why: explainPath(i.path),
      path: i.path.map((h) => ({ from: h.from, to: h.to, type: h.type })),
    })),
    steps: plan.steps.map((s) => ({ id: s.item.id, class: s.item.class, waitsFor: [...s.waitsFor] })),
    cycles: plan.cycles.map((c) => [...c]),
    summary: { ...plan.summary },
  };
}

function jsonSafe(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? null : (JSON.parse(text) as unknown);
}

/** Terminal rendering of `starchart check` results. */
export function formatStaleText(stale: readonly StaleArtifact[], opts: { color?: boolean } = {}): string {
  const paint = palette(opts.color ?? false);
  if (stale.length === 0) return `${paint.auto("✓")} All artifacts are in sync with the lock.\n`;
  const lines: string[] = [];
  for (const s of stale) {
    if (s.unlocked) {
      lines.push(`  ${paint.review("? unlocked")}  ${s.id}  ${paint.dim("never synced; run `starchart lock` once it is correct")}`);
      continue;
    }
    lines.push(`  ${paint.break("✗ stale")}     ${s.id}`);
    for (const dep of s.changed) lines.push(paint.dim(`                changed: ${dep}`));
  }
  const unlocked = stale.filter((s) => s.unlocked).length;
  const staleCount = stale.length - unlocked;
  const parts = [staleCount ? `${staleCount} stale` : "", unlocked ? `${unlocked} unlocked` : ""].filter(Boolean);
  lines.push("", `${paint.bold("Check:")} ${parts.join(" · ")}`);
  return `${lines.join("\n")}\n`;
}

/** Markdown rendering of `starchart check` results. */
export function formatStaleMarkdown(stale: readonly StaleArtifact[], opts: { title?: string } = {}): string {
  const out = [`## ${opts.title ?? "🌌 STARCHART drift check"}`, ""];
  if (stale.length === 0) {
    out.push("✅ All artifacts are in sync with `starchart.lock`.", "");
    return out.join("\n");
  }
  out.push("| Artifact | Status | Changed dependencies |", "|---|---|---|");
  for (const s of stale) {
    const deps = s.unlocked ? "never locked" : s.changed.map(codeCell).join("<br>");
    out.push(`| ${codeCell(s.id)} | ${s.unlocked ? "? unlocked" : "✗ stale"} | ${deps} |`);
  }
  out.push("");
  return out.join("\n");
}
