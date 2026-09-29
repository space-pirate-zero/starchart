import type { Diff } from "../adapters/types.js";
import type { Graph } from "../core/graph.js";
import { staleArtifacts, type LockFile } from "../core/lock.js";
import { isExpired } from "../rules/util.js";

/** Reality Score: the share of live world artifacts that are bound, in sync and fresh. */

export interface ScoreReport {
  /** 0-100 integer. */
  score: number;
  total: number;
  inSync: number;
  breakdown: {
    unbound: string[];
    /** Stale per the lock, including artifacts that were never locked. */
    stale: string[];
    expired: string[];
    failingAudit: string[];
  };
}

export interface ScoreOptions {
  now?: Date;
  auditDiffs?: Diff[];
}

/**
 * An artifact is in sync when it has a binding, is not stale against the lock (unlocked
 * counts as stale), has not expired, and has no audit diffs. Retired artifacts are excluded.
 */
export function realityScore(graph: Graph, lock: LockFile, opts: ScoreOptions = {}): ScoreReport {
  const now = opts.now ?? new Date();
  const artifacts = graph
    .nodes({ kind: "artifact" })
    .filter((a) => a.status !== "retired")
    .sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(artifacts.map((a) => a.id));
  const staleIds = new Set(staleArtifacts(graph, lock).map((s) => s.id));
  const failingIds = new Set((opts.auditDiffs ?? []).map((d) => d.artifact));

  const breakdown: ScoreReport["breakdown"] = {
    unbound: artifacts.filter((a) => !a.binding).map((a) => a.id),
    stale: [...staleIds].filter((id) => ids.has(id)).sort(),
    expired: artifacts.filter((a) => isExpired(a, now)).map((a) => a.id),
    failingAudit: [...failingIds].filter((id) => ids.has(id)).sort(),
  };
  const bad = new Set([...breakdown.unbound, ...breakdown.stale, ...breakdown.expired, ...breakdown.failingAudit]);
  const total = artifacts.length;
  const inSync = total - bad.size;
  const score = total === 0 ? 100 : Math.round((100 * inSync) / total);
  return { score, total, inSync, breakdown };
}

export function scoreColor(score: number): string {
  if (score >= 95) return "#00ff41";
  if (score >= 80) return "#ffd000";
  return "#ff1493";
}

const clampScore = (score: number): number => Math.max(0, Math.min(100, Math.round(Number.isFinite(score) ? score : 0)));

/** Approximate Verdana 11px advance widths (px), as used by shields.io badges. */
const WIDE = new Set([..."mwMW%@"]);
const NARROW = new Set([..."iljtfrI.,:;!|' "]);
function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (WIDE.has(ch)) w += 10.5;
    else if (NARROW.has(ch)) w += 3.8;
    else if (/[A-Z0-9]/.test(ch)) w += 7.5;
    else w += 6.6;
  }
  return Math.round(w);
}

const escapeXml = (s: string): string => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Shields-style flat badge: `reality | 97%`. Standalone SVG. */
export function badgeSvg(score: number): string {
  const value = `${clampScore(score)}%`;
  const label = "reality";
  const color = scoreColor(clampScore(score));
  const valueText = color === "#00ff41" ? "#0b0b0b" : color === "#ffd000" ? "#1a1a1a" : "#fff";
  const valueShadow = valueText === "#fff" ? "#010101" : "#ccc";
  const lw = textWidth(label) + 10;
  const vw = textWidth(value) + 10;
  const w = lw + vw;
  const title = escapeXml(`${label}: ${value}`);
  const lx = (lw / 2) * 10;
  const vx = (lw + vw / 2) * 10;
  const ltl = (lw - 10) * 10;
  const vtl = (vw - 10) * 10;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`,
    `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">`,
    `<text aria-hidden="true" x="${lx}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${ltl}">${label}</text>`,
    `<text x="${lx}" y="140" transform="scale(.1)" fill="#fff" textLength="${ltl}">${label}</text>`,
    `<text aria-hidden="true" x="${vx}" y="150" fill="${valueShadow}" fill-opacity=".3" transform="scale(.1)" textLength="${vtl}">${value}</text>`,
    `<text x="${vx}" y="140" transform="scale(.1)" fill="${valueText}" textLength="${vtl}">${value}</text>`,
    `</g>`,
    `</svg>`,
  ].join("");
}

/** shields.io endpoint badge JSON. */
export function badgeJson(score: number): { schemaVersion: 1; label: string; message: string; color: string } {
  const s = clampScore(score);
  return { schemaVersion: 1, label: "reality", message: `${s}%`, color: scoreColor(s) };
}
