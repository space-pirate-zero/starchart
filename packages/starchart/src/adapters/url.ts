import type { GraphNode } from "../core/model.js";
import { errorMessage } from "./errors.js";
import { auditText, leafFacts } from "./text.js";
import type { Adapter, AdapterContext, Diff } from "./types.js";

/**
 * Live web pages (read-only).
 *
 * binding: { adapter: url, url: "/pricing" }  — relative URLs resolve against config `site`.
 *
 * The page's visible text, its `<meta>` tags (og:*, twitter:*, description) and its JSON-LD
 * blocks are checked for stale and missing embedded fact values. `describes` edges are semantic
 * and never checked here.
 */

export function resolveUrl(node: GraphNode, settings: Record<string, unknown>): string {
  const raw = node.binding?.url;
  if (typeof raw !== "string" || !raw) throw new Error(`${node.id}: url binding needs a "url"`);
  if (/^https?:\/\//i.test(raw)) return raw;
  const site = settings.site;
  if (typeof site !== "string" || !site) {
    throw new Error(`${node.id}: relative url "${raw}" needs "site" in .starchart/config.yaml`);
  }
  // bindings are relative to the whole site URL, including any base path it carries
  return new URL(raw.replace(/^\/+/, ""), site.endsWith("/") ? site : `${site}/`).toString();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  middot: "·",
  times: "×",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
};

/** Text a reader or crawler sees: body text, social meta tags and JSON-LD, one section per line block. */
export function extractPageText(html: string): string {
  const jsonLd: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = attr(m[1] ?? "", "type");
    if (type?.toLowerCase() === "application/ld+json") jsonLd.push((m[2] ?? "").trim());
  }
  const meta: string[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
    if (/^(og:|twitter:|description$|product:)/.test(key)) {
      const content = attr(tag, "content");
      if (content) meta.push(decodeEntities(content));
    }
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head\s*>/i, " ")
    .replace(/<(br|p|div|li|tr|h[1-6]|section|article|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/[ \t\r\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return [title ? decodeEntities(title).trim() : "", text, ...meta, ...jsonLd].filter(Boolean).join("\n");
}

function snippet(text: string, index: number): string {
  const s = text.slice(Math.max(0, index - 30), index + 40).replace(/\s+/g, " ").trim();
  return s.length > 0 ? `near "${s}"` : "";
}

async function fetchPage(url: string, ctx: AdapterContext): Promise<{ ok: true; html: string } | { ok: false; message: string; status?: number }> {
  try {
    const res = await ctx.fetch(url, { headers: { "user-agent": "starchart-audit", accept: "text/html,*/*" }, redirect: "follow" });
    if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}` };
    return { ok: true, html: await res.text() };
  } catch (e) {
    return { ok: false, message: `request failed: ${errorMessage(e)}` };
  }
}

export const urlAdapter: Adapter = {
  id: "url",
  capabilities: { read: true, write: false },

  async audit(node, ctx): Promise<Diff[]> {
    const url = resolveUrl(node, ctx.settings);
    const facts = leafFacts(ctx.graph, node.id, ["embeds", "mirrors", "renders"]);
    const page = await fetchPage(url, ctx);
    if (!page.ok) {
      // a page that is gone breaks the artifact; an unreachable network is an audit error, not drift
      if (page.status === 404 || page.status === 410) return [{ artifact: node.id, kind: "break", message: `${url}: ${page.message}`, where: url }];
      throw new Error(`${url}: ${page.message}`);
    }
    if (facts.length === 0) return [];
    const text = extractPageText(page.html);
    return auditText({
      artifact: node.id,
      text,
      facts,
      previous: ctx.previousValues,
      where: (i) => [url, snippet(text, i)].filter(Boolean).join(" "),
      whereMissing: url,
    });
  },
};
