import type { GraphNode } from "../../core/model.js";
import type { CustomRule, Finding, RulePack } from "../engine.js";
import { ancestors, charLength, formatValue, hasType, toNumber } from "../util.js";

const PACK = "seo";

export const OG_IMAGE = { width: 1200, height: 630 } as const;
export const META_LIMITS = { title: 60, description: 160 } as const;

const isOgImage = (n: GraphNode): boolean =>
  hasType(n, ["schema:ImageObject"]) && ((n.tags?.includes("og") ?? false) || /(^|[^a-z])og([^a-z]|$)/i.test(n.id));

const ogImageSize: CustomRule = {
  id: "seo-og-image-size",
  pack: PACK,
  severity: "warn",
  description: `Open Graph images are ${OG_IMAGE.width}x${OG_IMAGE.height}`,
  check(graph) {
    const out: Finding[] = [];
    for (const n of graph.nodes({ kind: "artifact" }).filter(isOgImage)) {
      const width = toNumber(n.meta?.width);
      const height = toNumber(n.meta?.height);
      if (width === undefined && height === undefined) continue;
      if (width === OG_IMAGE.width && height === OG_IMAGE.height) continue;
      out.push({
        node: n.id,
        message: `${n.id} is ${width ?? "?"}x${height ?? "?"}, Open Graph images should be ${OG_IMAGE.width}x${OG_IMAGE.height}`,
      });
    }
    return out;
  },
};

const isJsonLd = (n: GraphNode): boolean =>
  hasType(n, ["sc:JsonLd", "sc:JSONLD", "sc:StructuredData"]) || (n.tags?.some((t) => t === "jsonld" || t === "json-ld") ?? false);

const jsonLdRendersEntity: CustomRule = {
  id: "seo-jsonld-renders-entity",
  pack: PACK,
  severity: "info",
  description: "JSON-LD artifacts are rendered from an entity (or its facts), so structured data never drifts",
  check(graph) {
    const out: Finding[] = [];
    for (const n of graph.nodes({ kind: "artifact" }).filter(isJsonLd)) {
      const rendersEntity = graph.outgoing(n.id, "renders").some((e) => {
        const target = graph.node(e.to);
        if (!target) return false;
        if (target.kind === "entity") return true;
        return target.kind === "fact" && ancestors(graph, target.id).some((a) => graph.node(a)?.kind === "entity");
      });
      if (!rendersEntity) out.push({ node: n.id, message: `${n.id} is JSON-LD but does not render any entity; add renders: <entity>` });
    }
    return out;
  },
};

const metaLengths: CustomRule = {
  id: "seo-meta-length",
  pack: PACK,
  severity: "warn",
  description: `Web page titles fit ${META_LIMITS.title} chars and meta descriptions ${META_LIMITS.description} chars`,
  check(graph) {
    const out: Finding[] = [];
    for (const n of graph.nodes({ kind: "artifact" }).filter((x) => hasType(x, ["schema:WebPage"]))) {
      for (const field of ["title", "description"] as const) {
        const value = n.meta?.[field];
        if (typeof value !== "string") continue;
        const len = charLength(value);
        if (len > META_LIMITS[field]) out.push({ node: n.id, message: `${n.id} ${field} ${formatValue(value)} is ${len} chars (max ${META_LIMITS[field]})` });
      }
    }
    return out;
  },
};

export const pack: RulePack = {
  id: PACK,
  description: "SEO: Open Graph image size, JSON-LD bound to entities, title/description lengths",
  rules: [ogImageSize, jsonLdRendersEntity, metaLengths],
};
