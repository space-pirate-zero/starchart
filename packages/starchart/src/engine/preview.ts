import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { computeFsUpdate, type FsUpdate } from "../adapters/fs.js";
import { errorMessage } from "../adapters/errors.js";
import type { Plan } from "../api.js";
import { explainPath, type ImpactItem } from "../core/impact.js";
import type { Project } from "../project.js";
import { adapterContext } from "./context.js";

/**
 * "Future Universe" preview: the world as it will look after `apply`, as one self-contained HTML
 * page. fs artifacts are computed in dry mode (before/after files, rendered images, line diffs);
 * everything else is listed with its reason and the path explaining why it is impacted.
 */

export interface PreviewEntry {
  id: string;
  label?: string;
  class: ImpactItem["class"];
  adapter?: string;
  reason: string;
  why: string;
  kind: "text" | "image" | "external" | "task";
  /** Target path of an fs artifact (root-relative). */
  path?: string;
  /** Before/after copies, relative to the preview directory. */
  before?: string;
  after?: string;
  /** Unified line diff for text artifacts. */
  diff?: string;
  changes?: string[];
  error?: string;
}

const CLASS_ORDER: ImpactItem["class"][] = ["auto", "break", "manual", "review", "retire", "code"];

const slug = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);

export async function buildPreview(project: Project, plan: Plan, outDir: string): Promise<{ indexPath: string; entries: PreviewEntry[] }> {
  const dir = resolve(project.root, outDir);
  await mkdir(dir, { recursive: true });
  const entries: PreviewEntry[] = [];
  const images = new Map<string, string>();

  for (const { item } of plan.steps) {
    const adapter = item.node.binding?.adapter;
    const base: PreviewEntry = {
      id: item.id,
      label: item.node.label,
      class: item.class,
      adapter,
      reason: item.reason,
      why: explainPath(item.path),
      kind: item.class === "auto" ? "external" : "task",
    };
    if (item.class !== "auto" || adapter !== "fs") {
      entries.push(base);
      continue;
    }
    let update: FsUpdate;
    try {
      update = await computeFsUpdate(item.node, adapterContext(project, "fs", { dryRun: true }));
    } catch (e) {
      entries.push({ ...base, kind: "text", error: errorMessage(e) });
      continue;
    }
    const entry: PreviewEntry = { ...base, kind: update.kind === "text" ? "text" : "image", path: update.path, changes: update.changes };
    if (update.error) {
      entries.push({ ...entry, error: update.error });
      continue;
    }
    const ext = extname(update.path) || ".txt";
    const folder = join("files", slug(item.id));
    await mkdir(join(dir, folder), { recursive: true });
    if (update.before) {
      entry.before = join(folder, `before${ext}`);
      await writeFile(join(dir, entry.before), update.before);
    }
    entry.after = join(folder, `after${ext}`);
    await writeFile(join(dir, entry.after), update.after);
    if (entry.kind === "image") {
      const mime = update.kind === "png" ? "image/png" : "image/svg+xml";
      if (update.before) images.set(entry.before!, `data:${mime};base64,${update.before.toString("base64")}`);
      images.set(entry.after, `data:${mime};base64,${update.after.toString("base64")}`);
    } else {
      entry.diff = unifiedDiff(update.before?.toString("utf8") ?? "", update.after.toString("utf8"), update.path);
    }
    entries.push(entry);
  }

  const indexPath = join(dir, "index.html");
  await writeFile(indexPath, renderHtml(project, plan, entries, images));
  return { indexPath, entries };
}

// ---------------------------------------------------------------- diff

type Op = { type: " " | "-" | "+"; line: string };

function diffLines(a: string[], b: string[]): Op[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const am = a.slice(prefix, a.length - suffix);
  const bm = b.slice(prefix, b.length - suffix);
  const n = am.length;
  const m = bm.length;
  const ops: Op[] = a.slice(0, prefix).map((line) => ({ type: " ", line }));
  const tail = a.slice(a.length - suffix).map((line): Op => ({ type: " ", line }));
  if (n * m > 4_000_000) {
    // too large for a line-level LCS: show the differing middle as a block replacement
    return [...ops, ...am.map((line): Op => ({ type: "-", line })), ...bm.map((line): Op => ({ type: "+", line })), ...tail];
  }
  // LCS table over the differing middle
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = am[i] === bm[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (am[i] === bm[j]) {
      ops.push({ type: " ", line: am[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ type: "-", line: am[i++]! });
    else ops.push({ type: "+", line: bm[j++]! });
  }
  while (i < n) ops.push({ type: "-", line: am[i++]! });
  while (j < m) ops.push({ type: "+", line: bm[j++]! });
  return [...ops, ...tail];
}

/** Unified diff with 3 lines of context; empty string when the texts are equal. */
export function unifiedDiff(before: string, after: string, path: string, context = 3): string {
  if (before === after) return "";
  const ops = diffLines(before.split("\n"), after.split("\n"));
  const changed = ops.map((o, idx) => (o.type !== " " ? idx : -1)).filter((idx) => idx >= 0);
  const hunks: [number, number][] = [];
  for (const idx of changed) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length, idx + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const [start, end] of hunks) {
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < start; k++) {
      if (ops[k]!.type !== "+") oldLine++;
      if (ops[k]!.type !== "-") newLine++;
    }
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((o) => o.type !== "+").length;
    const newCount = slice.filter((o) => o.type !== "-").length;
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    for (const o of slice) out.push(`${o.type}${o.line}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- html

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#030303;color:#f5f5f5;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:32px 16px}
main{max-width:1200px;margin:0 auto}
h1,h2,h3,.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
h1{font-size:40px;margin:0 0 4px;color:#ff1493;text-transform:uppercase;letter-spacing:2px;text-shadow:4px 4px 0 #000,6px 6px 0 #00ff41}
.sub{color:#00ff41;margin:0 0 28px;font-family:ui-monospace,Menlo,monospace}
.stats{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:36px}
.stat{background:#111;border:3px solid #000;box-shadow:6px 6px 0 #ff1493;padding:12px 18px;min-width:120px}
.stat b{display:block;font-size:30px;font-family:ui-monospace,Menlo,monospace;color:#00ff41}
.stat span{text-transform:uppercase;font-size:12px;letter-spacing:1px}
h2{font-size:22px;text-transform:uppercase;letter-spacing:2px;border-bottom:3px solid #ff1493;padding-bottom:6px;margin:36px 0 18px}
.card{background:#101010;border:3px solid #000;box-shadow:6px 6px 0 #ff1493;padding:18px;margin:0 0 24px;outline:1px solid #222}
.card.break{box-shadow:6px 6px 0 #ff2a2a}
.card.auto{box-shadow:6px 6px 0 #00ff41}
.card h3{margin:0 0 6px;font-size:17px;word-break:break-all}
.tag{display:inline-block;border:2px solid #000;background:#ff1493;color:#030303;font:700 11px/1 ui-monospace,Menlo,monospace;padding:4px 7px;text-transform:uppercase;margin-right:6px;box-shadow:2px 2px 0 #000}
.tag.green{background:#00ff41}
.reason{margin:8px 0}
.why{font:12px/1.5 ui-monospace,Menlo,monospace;color:#bdbdbd;background:#060606;border:2px solid #000;padding:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.err{color:#ff5a5a;font-weight:700}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px}
@media(max-width:720px){.pair{grid-template-columns:1fr}}
.pair figure{margin:0;background:#1a1a1a;border:3px solid #000;box-shadow:4px 4px 0 #00ff41;padding:8px}
.pair figcaption{font:700 12px ui-monospace,Menlo,monospace;text-transform:uppercase;margin-bottom:6px;color:#00ff41}
.pair img{max-width:100%;height:auto;display:block;background:#fff}
pre.diff{background:#060606;border:3px solid #000;box-shadow:4px 4px 0 #ff1493;padding:10px;overflow-x:auto;font:12.5px/1.45 ui-monospace,Menlo,monospace;margin:12px 0 0}
pre.diff span{display:block;white-space:pre}
.add{color:#00ff41;background:rgba(0,255,65,.08)}
.del{color:#ff1493;background:rgba(255,20,147,.1)}
.hunk{color:#7aa2ff}
ul.changes{margin:8px 0 0;padding-left:20px;font-family:ui-monospace,Menlo,monospace;font-size:13px}
.empty{color:#888;font-style:italic}
`;

function renderDiff(diff: string): string {
  const lines = diff.split("\n").map((line) => {
    const cls = line.startsWith("+++") || line.startsWith("---") ? "hunk" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
    return `<span${cls ? ` class="${cls}"` : ""}>${escapeHtml(line) || " "}</span>`;
  });
  return `<pre class="diff">${lines.join("")}</pre>`;
}

function renderEntry(e: PreviewEntry, images: Map<string, string>): string {
  const parts = [`<article class="card ${escapeHtml(e.class)}">`];
  parts.push(`<h3>${escapeHtml(e.label ? `${e.label} · ${e.id}` : e.id)}</h3>`);
  parts.push(
    `<div><span class="tag${e.class === "auto" ? " green" : ""}">${escapeHtml(e.class)}</span>${e.adapter ? `<span class="tag">${escapeHtml(e.adapter)}</span>` : ""}${e.path ? `<span class="mono">${escapeHtml(e.path)}</span>` : ""}</div>`,
  );
  parts.push(`<p class="reason">${escapeHtml(e.reason)}</p>`);
  if (e.why) parts.push(`<div class="why">why: ${escapeHtml(e.why)}</div>`);
  if (e.error) parts.push(`<p class="err">${escapeHtml(e.error)}</p>`);
  if (e.changes?.length) parts.push(`<ul class="changes">${e.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`);
  if (e.kind === "image" && e.after) {
    const img = (rel: string | undefined, caption: string) =>
      `<figure><figcaption>${caption}</figcaption>${rel && images.has(rel) ? `<img alt="${escapeHtml(`${caption} ${e.id}`)}" src="${escapeHtml(images.get(rel)!)}">` : `<p class="empty">does not exist yet</p>`}</figure>`;
    parts.push(`<div class="pair">${img(e.before, "Before")}${img(e.after, "After")}</div>`);
  }
  if (e.kind === "text" && !e.error) parts.push(e.diff ? renderDiff(e.diff) : `<p class="empty">already up to date</p>`);
  if (e.kind === "external") parts.push(`<p class="empty">synced through the ${escapeHtml(e.adapter ?? "")} adapter on apply; preview shows no live data</p>`);
  parts.push("</article>");
  return parts.join("\n");
}

function renderHtml(project: Project, plan: Plan, entries: PreviewEntry[], images: Map<string, string>): string {
  const counts = CLASS_ORDER.map((cls) => [cls, entries.filter((e) => e.class === cls).length] as const).filter(([, n]) => n > 0);
  const changes = plan.changes.map((c) => c.id);
  const groups = CLASS_ORDER.map((cls) => {
    const list = entries.filter((e) => e.class === cls);
    if (list.length === 0) return "";
    return `<section><h2>${escapeHtml(cls)} · ${list.length}</h2>\n${list.map((e) => renderEntry(e, images)).join("\n")}</section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(project.loaded.config.name)} · Future Universe</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>Future Universe</h1>
<p class="sub">${escapeHtml(project.loaded.config.name)} · ${escapeHtml(changes.length ? `changed: ${changes.join(", ")}` : "no changes since the lock")}</p>
<div class="stats">
<div class="stat"><b>${entries.length}</b><span>artifacts</span></div>
${counts.map(([cls, n]) => `<div class="stat"><b>${n}</b><span>${escapeHtml(cls)}</span></div>`).join("\n")}
</div>
${groups || `<p class="empty">Nothing is impacted.</p>`}
</main>
</body>
</html>
`;
}
