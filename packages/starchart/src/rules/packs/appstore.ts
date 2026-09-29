import type { Graph } from "../../core/graph.js";
import type { GraphNode } from "../../core/model.js";
import { checkValue, defineRule, type CustomRule, type Finding, type RulePack } from "../engine.js";
import { descendantFacts, hasType, isLocaleMap } from "../util.js";

const PACK = "appstore";

/** App Store Connect character limits per metadata field. */
export const APPSTORE_LIMITS = {
  name: 30,
  subtitle: 30,
  promotionalText: 170,
  description: 4000,
  keywords: 100,
  whatsNew: 4000,
} as const;

export type AppStoreField = keyof typeof APPSTORE_LIMITS;

const FIELD_ALIASES: Record<string, AppStoreField> = {
  name: "name",
  title: "name",
  subtitle: "subtitle",
  promotionaltext: "promotionalText",
  promotional_text: "promotionalText",
  description: "description",
  keywords: "keywords",
  whatsnew: "whatsNew",
  whats_new: "whatsNew",
  releasenotes: "whatsNew",
  release_notes: "whatsNew",
};

export const LISTING_TYPES = ["sc:AppStoreListing"] as const;
const APP_TYPES = ["sc:App", "schema:MobileApplication", "schema:SoftwareApplication"];

const resolveField = (raw: unknown): AppStoreField | undefined => (typeof raw === "string" ? FIELD_ALIASES[raw.toLowerCase()] : undefined);

const isAppStoreArtifact = (n: GraphNode): boolean => n.kind === "artifact" && n.binding?.adapter === "appstore";

const listingLimits = defineRule({
  id: "appstore-listing-limits",
  pack: PACK,
  severity: "error",
  description: "App Store listing text fits App Store Connect limits, in every locale",
  select: { kind: "entity", type: [...LISTING_TYPES] },
  require: {
    value: (Object.entries(APPSTORE_LIMITS) as [AppStoreField, number][]).map(([fact, maxLength]) => ({ fact, maxLength })),
  },
});

/**
 * The text an App Store field artifact carries: `meta.text`, or the single fact it
 * embeds/mirrors/renders when that fact holds text (or a locale map of text).
 */
function artifactText(graph: Graph, node: GraphNode): unknown {
  if (node.meta?.text !== undefined) return node.meta.text;
  const linked = graph
    .outgoing(node.id)
    .filter((e) => e.type === "embeds" || e.type === "mirrors" || e.type === "renders")
    .map((e) => graph.node(e.to))
    .filter((n): n is GraphNode => n?.kind === "fact" && (typeof n.value === "string" || isLocaleMap(n.value)));
  if (linked.length !== 1) return undefined;
  const value = linked[0]!.value;
  const locale = node.binding?.locale;
  if (typeof locale === "string" && isLocaleMap(value)) return value[locale];
  return value;
}

const fieldLimits: CustomRule = {
  id: "appstore-field-limits",
  pack: PACK,
  severity: "error",
  description: "App Store field artifacts (binding.field) fit App Store Connect limits",
  check(graph) {
    const out: Finding[] = [];
    for (const node of graph.nodes({ kind: "artifact" }).filter(isAppStoreArtifact)) {
      const field = resolveField(node.binding?.field);
      if (!field) continue;
      const text = artifactText(graph, node);
      for (const message of checkValue(text, { maxLength: APPSTORE_LIMITS[field] }, `${node.id} ${field}`)) out.push({ node: node.id, message });
    }
    return out;
  },
};

function keywordTexts(graph: Graph): { node: string; subject: string; value: unknown }[] {
  const out: { node: string; subject: string; value: unknown }[] = [];
  for (const entity of graph.nodes({ kind: "entity" }).filter((n) => hasType(n, LISTING_TYPES))) {
    const fact = graph.node(`${entity.id}.keywords`);
    if (fact) out.push({ node: entity.id, subject: `${entity.id} keywords`, value: fact.value });
  }
  for (const node of graph.nodes({ kind: "artifact" }).filter(isAppStoreArtifact)) {
    if (resolveField(node.binding?.field) === "keywords") out.push({ node: node.id, subject: `${node.id} keywords`, value: artifactText(graph, node) });
  }
  return out;
}

const keywordSpacing: CustomRule = {
  id: "appstore-keywords-spacing",
  pack: PACK,
  severity: "warn",
  description: "Keywords are comma separated without spaces (spaces waste the 100-char budget)",
  check(graph) {
    const out: Finding[] = [];
    for (const { node, subject, value } of keywordTexts(graph)) {
      const entries: [string, unknown][] = isLocaleMap(value)
        ? Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        : [["", value]];
      for (const [locale, text] of entries) {
        if (typeof text !== "string") continue;
        const wasted = (text.match(/,\s+/g) ?? []).reduce((n, m) => n + m.length - 1, 0);
        if (wasted === 0) continue;
        out.push({ node, message: `${subject}${locale ? ` [${locale}]` : ""} has spaces after commas (${wasted} of ${APPSTORE_LIMITS.keywords} chars wasted)` });
      }
    }
    return out;
  },
};

const DISPLAY_TYPES: Record<string, string> = {
  APP_IPHONE_69: "6.9",
  APP_IPHONE_67: "6.7",
  APP_IPHONE_65: "6.5",
  APP_IPHONE_61: "6.1",
  APP_IPHONE_58: "5.8",
  APP_IPHONE_55: "5.5",
  APP_IPHONE_47: "4.7",
  APP_IPHONE_40: "4",
  APP_IPAD_PRO_3GEN_129: "12.9",
  APP_IPAD_PRO_129: "12.9",
  APP_IPAD_PRO_3GEN_11: "11",
  APP_IPAD_105: "10.5",
  APP_IPAD_97: "9.7",
};

/** "6.9", 6.9, '6.9"', "6.9in", "APP_IPHONE_69" → "6.9". */
export function normalizeScreenshotSet(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== "string") return undefined;
  const display = DISPLAY_TYPES[raw.toUpperCase()];
  if (display) return display;
  const m = /^\s*(\d+(?:\.\d+)?)/.exec(raw);
  return m ? String(Number(m[1])) : undefined;
}

/** 6.7" screenshots are accepted in the 6.9" slot by App Store Connect. */
const REQUIRED_IPHONE = ["6.9", "6.7", "6.5"];
const REQUIRED_IPAD = ["13", "12.9"];

const screenshotSets: CustomRule = {
  id: "appstore-screenshot-sets",
  pack: PACK,
  severity: "error",
  description: 'Screenshot sets include the required 6.9" (or 6.5") iPhone size and, for iPad apps, 13" (or 12.9")',
  check(graph) {
    const shots = graph
      .nodes({ kind: "artifact" })
      .filter((n) => isAppStoreArtifact(n) && n.binding?.set !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (shots.length === 0) return [];
    const app = graph
      .nodes({ kind: "entity" })
      .filter((n) => hasType(n, APP_TYPES))
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    const groups = new Map<string, GraphNode[]>();
    for (const s of shots) {
      const locale = typeof s.binding?.locale === "string" ? s.binding.locale : "";
      groups.set(locale, [...(groups.get(locale) ?? []), s]);
    }
    const out: Finding[] = [];
    for (const [locale, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const sets = group.map((s) => normalizeScreenshotSet(s.binding?.set)).filter((s): s is string => s !== undefined);
      const phones = sets.filter((s) => Number(s) < 8);
      const pads = sets.filter((s) => Number(s) >= 8);
      const node = app?.id ?? group[0]!.id;
      const where = locale ? ` for ${locale}` : "";
      const have = (xs: string[]) => [...new Set(xs)].sort().map((s) => `${s}"`).join(", ");
      if (phones.length > 0 && !phones.some((s) => REQUIRED_IPHONE.includes(s))) {
        out.push({ node, message: `missing required iPhone 6.9" (or 6.5") screenshot set${where}; have ${have(phones)}` });
      }
      if (pads.length > 0 && !pads.some((s) => REQUIRED_IPAD.includes(s))) {
        out.push({ node, message: `missing required iPad 13" (or 12.9") screenshot set${where}; have ${have(pads)}` });
      }
    }
    return out;
  },
};

const RECURRING = new Set(["weekly", "monthly", "bimonthly", "quarterly", "semiannual", "yearly", "annual", "annually"]);
const PURCHASE_PACKAGES = ["pkg:swift/purchases-ios", "pkg:npm/react-native-purchases", "pkg:gradle/com.revenuecat.purchases:purchases"];

const subscriptionMirrored: CustomRule = {
  id: "appstore-subscription-mirrored",
  pack: PACK,
  severity: "warn",
  description: "Recurring offers are mirrored by an App Store or Play Store product when the app sells in-app",
  check(graph) {
    const sellsInApp = PURCHASE_PACKAGES.some((p) => graph.hasNode(p)) || graph.nodes({ kind: "artifact" }).some(isAppStoreArtifact);
    if (!sellsInApp) return [];
    const out: Finding[] = [];
    for (const offer of graph.nodes({ kind: "entity" }).filter((n) => hasType(n, ["schema:Offer"]))) {
      if (offer.status === "retired" || offer.status === "deprecated") continue;
      const billing = graph.node(`${offer.id}.billing`)?.value;
      if (typeof billing !== "string" || !RECURRING.has(billing.toLowerCase())) continue;
      const mirrored = [offer.id, ...descendantFacts(graph, offer.id)].some((id) =>
        graph.incoming(id, "mirrors").some((e) => {
          const adapter = graph.node(e.from)?.binding?.adapter;
          return adapter === "appstore" || adapter === "playstore";
        }),
      );
      if (!mirrored) out.push({ node: offer.id, message: `${offer.id} is a ${billing} subscription but no App Store or Play Store product mirrors it` });
    }
    return out;
  },
};

export const pack: RulePack = {
  id: PACK,
  description: "App Store Connect: metadata character limits, keyword formatting, required screenshot sets, subscription products",
  rules: [listingLimits, fieldLimits, keywordSpacing, screenshotSets, subscriptionMirrored],
};
