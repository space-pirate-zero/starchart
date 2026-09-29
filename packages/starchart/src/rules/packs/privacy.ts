import { readFileSync } from "node:fs";
import { join } from "node:path";
import fg from "fast-glob";
import type { Graph } from "../../core/graph.js";
import type { GraphNode } from "../../core/model.js";
import type { CustomRule, Finding, RuleContext, RulePack } from "../engine.js";
import { parsePlist, type PlistValue } from "../plist.js";
import { hasType, matchPattern } from "../util.js";
import {
  APPLE_DATA_TYPE_PREFIX,
  PLAY_CATEGORY,
  PRIVACY_CATALOG,
  appleDataTypeKey,
  normalizeDataType,
  type AppleDataType,
  type SdkCatalogEntry,
} from "./privacy-catalog.js";

const PACK = "privacy";

export type Platform = "ios" | "android" | "web" | "server";
const ALL_PLATFORMS: Platform[] = ["ios", "android", "web", "server"];

// ---------------------------------------------------------------------------------------------
// PrivacyInfo.xcprivacy

export interface ManifestCollectedType {
  /** Full key, e.g. NSPrivacyCollectedDataTypeCrashData. */
  key: string;
  /** Apple short name when recognised, e.g. CrashData. */
  type?: AppleDataType;
  linked?: boolean;
  tracking?: boolean;
  purposes: string[];
}

export interface PrivacyManifest {
  /** NSPrivacyTracking; undefined when the key is absent. */
  tracking?: boolean;
  trackingDomains: string[];
  collected: ManifestCollectedType[];
  accessedApiTypes: string[];
}

const isDict = (v: PlistValue | undefined): v is Record<string, PlistValue> => v !== undefined && typeof v === "object" && !Array.isArray(v);
const strings = (v: PlistValue | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Parses an Apple privacy manifest (PrivacyInfo.xcprivacy, XML plist). Throws on malformed XML. */
export function parsePrivacyManifest(xml: string): PrivacyManifest {
  const root = parsePlist(xml);
  if (!isDict(root)) throw new Error("privacy manifest root must be a <dict>");
  const collected: ManifestCollectedType[] = [];
  const rawCollected = root.NSPrivacyCollectedDataTypes;
  for (const entry of Array.isArray(rawCollected) ? rawCollected : []) {
    if (!isDict(entry) || typeof entry.NSPrivacyCollectedDataType !== "string") continue;
    const key = entry.NSPrivacyCollectedDataType.trim();
    const item: ManifestCollectedType = { key, purposes: strings(entry.NSPrivacyCollectedDataTypePurposes) };
    const type = normalizeDataType(key)[0];
    if (type && key.startsWith(APPLE_DATA_TYPE_PREFIX)) item.type = type;
    if (typeof entry.NSPrivacyCollectedDataTypeLinked === "boolean") item.linked = entry.NSPrivacyCollectedDataTypeLinked;
    if (typeof entry.NSPrivacyCollectedDataTypeTracking === "boolean") item.tracking = entry.NSPrivacyCollectedDataTypeTracking;
    collected.push(item);
  }
  const accessed = Array.isArray(root.NSPrivacyAccessedAPITypes) ? root.NSPrivacyAccessedAPITypes : [];
  const manifest: PrivacyManifest = {
    trackingDomains: strings(root.NSPrivacyTrackingDomains),
    collected,
    accessedApiTypes: accessed.filter(isDict).flatMap((d) => (typeof d.NSPrivacyAccessedAPIType === "string" ? [d.NSPrivacyAccessedAPIType] : [])),
  };
  if (typeof root.NSPrivacyTracking === "boolean") manifest.tracking = root.NSPrivacyTracking;
  return manifest;
}

// ---------------------------------------------------------------------------------------------
// detection

export interface DetectedCollection {
  /** Catalog entry id (e.g. "sentry"), or "app-events" for first-party analytics events. */
  sdk: string;
  /** Package node id (or `event:*`). */
  package: string;
  /** Apple short names the SDK collects by default. */
  dataTypes: string[];
  /** Collected only when optional features are used; reported, not enforced. */
  optionalDataTypes: string[];
  tracking: boolean;
  platforms: Platform[];
  source: string;
}

/** Platforms a package ships on, from its ecosystem and name. */
export function packagePlatforms(id: string): Platform[] {
  const m = /^pkg:([^/]+)\/(.+)$/.exec(id);
  if (!m) return ALL_PLATFORMS;
  const eco = m[1]!.toLowerCase();
  const name = m[2]!.toLowerCase();
  if (eco === "swift" || eco === "cocoapods" || eco === "carthage") return ["ios"];
  if (eco === "gradle" || eco === "maven") return ["android"];
  if (eco === "pub") return ["ios", "android"];
  if (eco === "npm") {
    if (/react-native|expo|capacitor|cordova|ionic/.test(name)) return ["ios", "android"];
    if (/(^|[-/])node($|[-/])|server/.test(name)) return ["server"];
    return ["web"];
  }
  return ["server"];
}

/** A package counts when code depends on it, or it is a direct (declared) dependency. */
function packageDetected(graph: Graph, node: GraphNode): boolean {
  if (graph.incoming(node.id, "dependsOn").length > 0) return true;
  const meta = node.meta ?? {};
  return meta.declared === true || meta.direct === true || meta.transitive === false;
}

interface PrivacyOverride {
  collects?: string[];
  optional?: string[];
  tracking?: boolean;
}

function readOverride(node: GraphNode): PrivacyOverride | undefined {
  const raw = node.meta?.privacy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  const out: PrivacyOverride = {};
  const collects = list(o.collects);
  const optional = list(o.optional);
  if (collects) out.collects = collects;
  if (optional) out.optional = optional;
  if (typeof o.tracking === "boolean") out.tracking = o.tracking;
  return out;
}

const normalizeAll = (xs: string[]): string[] => [...new Set(xs.flatMap(normalizeDataType))].sort();

const EXT_PLATFORM: [RegExp, Platform][] = [
  [/\.(swift|m|mm)$/, "ios"],
  [/\.(kt|kts|java)$/, "android"],
  [/\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/, "web"],
  [/\.(go|py|rb|rs)$/, "server"],
];

function emitterPlatforms(graph: Graph, events: GraphNode[]): Platform[] {
  const found = new Set<Platform>();
  for (const ev of events) {
    for (const e of graph.incoming(ev.id, "emits")) {
      const n = graph.node(e.from);
      const path = n?.location?.file ?? (typeof n?.meta?.path === "string" ? n.meta.path : undefined);
      const hit = path ? EXT_PLATFORM.find(([re]) => re.test(path)) : undefined;
      if (!hit) return ALL_PLATFORMS;
      found.add(hit[1]);
    }
  }
  return found.size ? [...found].sort() : ALL_PLATFORMS;
}

/**
 * Data collection implied by the code layer: every detected SDK package matched against the
 * catalog (or its `meta.privacy` override), plus first-party analytics events.
 */
export function detectCollection(graph: Graph, catalog: SdkCatalogEntry[] = PRIVACY_CATALOG): DetectedCollection[] {
  const out: DetectedCollection[] = [];
  const packages = graph.nodes().filter((n) => (n.kind === "package" || n.id.startsWith("pkg:")) && packageDetected(graph, n));
  for (const pkg of packages.sort((a, b) => a.id.localeCompare(b.id))) {
    const override = readOverride(pkg);
    const entries = catalog.filter((e) => e.packages.some((p) => matchPattern(p, pkg.id, true)));
    if (override && (override.collects || override.optional || override.tracking !== undefined)) {
      const base = entries[0];
      out.push({
        sdk: base?.id ?? pkg.id,
        package: pkg.id,
        dataTypes: normalizeAll(override.collects ?? base?.collects.filter((c) => !c.optional).map((c) => c.type) ?? []),
        optionalDataTypes: normalizeAll(override.optional ?? base?.collects.filter((c) => c.optional).map((c) => c.type) ?? []),
        tracking: override.tracking ?? base?.tracking ?? false,
        platforms: packagePlatforms(pkg.id),
        source: `${pkg.id} meta.privacy`,
      });
      continue;
    }
    for (const entry of entries) {
      out.push({
        sdk: entry.id,
        package: pkg.id,
        dataTypes: [...new Set(entry.collects.filter((c) => !c.optional).map((c) => c.type))].sort(),
        optionalDataTypes: [...new Set(entry.collects.filter((c) => c.optional).map((c) => c.type))].sort(),
        tracking: entry.tracking,
        platforms: packagePlatforms(pkg.id),
        source: entry.source,
      });
    }
  }
  const events = graph.nodes({ kind: "event" });
  if (events.length > 0 && !out.some((d) => d.dataTypes.includes("ProductInteraction"))) {
    out.push({
      sdk: "app-events",
      package: "event:*",
      dataTypes: ["ProductInteraction"],
      optionalDataTypes: [],
      tracking: false,
      platforms: emitterPlatforms(graph, events),
      source: `${events.length} analytics event(s) in code`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// disclosures

export interface DisclosureSource {
  kind: "manifest" | "label" | "policy";
  /** Manifest path (root-relative) or artifact id. */
  id: string;
  /** Human name used in messages. */
  name: string;
  platforms: Platform[];
  declares: Set<string>;
  tracking?: boolean;
  /** Play Data Safety labels are reported with Play category names. */
  vocabulary: "apple" | "play";
  file?: string;
  error?: string;
}

const MANIFEST_IGNORE = ["**/node_modules/**", "**/Pods/**", "**/DerivedData/**", "**/.build/**", "**/Carthage/**", "**/.git/**"];

/** Finds and parses every first-party privacy manifest under `root`. */
export function findPrivacyManifests(root: string): { path: string; manifest?: PrivacyManifest; error?: string }[] {
  const paths = fg.sync("**/*.xcprivacy", { cwd: root, ignore: MANIFEST_IGNORE, dot: false }).sort();
  return paths.map((path) => {
    try {
      return { path, manifest: parsePrivacyManifest(readFileSync(join(root, path), "utf8")) };
    } catch (err) {
      return { path, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function artifactPlatforms(node: GraphNode): Platform[] {
  const raw = node.meta?.platform ?? node.meta?.platforms;
  const listed = (Array.isArray(raw) ? raw : [raw]).filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase());
  const valid = listed.filter((x): x is Platform => (ALL_PLATFORMS as string[]).includes(x));
  if (valid.length) return valid;
  if (node.binding?.adapter === "appstore") return ["ios"];
  if (node.binding?.adapter === "playstore") return ["android"];
  return ALL_PLATFORMS;
}

function artifactSource(node: GraphNode, kind: "label" | "policy"): DisclosureSource | undefined {
  const declares = node.meta?.declares;
  if (!Array.isArray(declares)) return undefined;
  const platforms = artifactPlatforms(node);
  const vocabulary = platforms.length === 1 && platforms[0] === "android" ? "play" : "apple";
  const source: DisclosureSource = {
    kind,
    id: node.id,
    name: kind === "policy" ? `privacy policy ${node.id}` : vocabulary === "play" ? `Play Data Safety label ${node.id}` : `privacy label ${node.id}`,
    platforms,
    declares: new Set(normalizeAll(declares.filter((d): d is string => typeof d === "string"))),
    vocabulary,
  };
  if (typeof node.meta?.tracking === "boolean") source.tracking = node.meta.tracking;
  if (typeof node.meta?.file === "string") source.file = node.meta.file;
  return source;
}

/** Every disclosure present: manifests under ctx.root, sc:PrivacyLabel and sc:PrivacyPolicy artifacts. Memoized per evaluation. */
export function disclosureSources(graph: Graph, ctx: Pick<RuleContext, "root" | "cache">): DisclosureSource[] {
  const cached = ctx.cache.get("privacy:sources") as DisclosureSource[] | undefined;
  if (cached) return cached;
  const sources: DisclosureSource[] = [];
  if (ctx.root) {
    for (const m of findPrivacyManifests(ctx.root)) {
      const base = m.path.split("/").pop()!;
      const source: DisclosureSource = {
        kind: "manifest",
        id: m.path,
        name: `${base} (${m.path})`,
        platforms: ["ios"],
        declares: new Set(m.manifest?.collected.flatMap((c) => (c.type ? [c.type] : [])) ?? []),
        vocabulary: "apple",
        file: m.path,
      };
      if (m.manifest?.tracking !== undefined) source.tracking = m.manifest.tracking;
      if (m.error) source.error = m.error;
      sources.push(source);
    }
  }
  for (const node of graph.nodes({ kind: "artifact" }).sort((a, b) => a.id.localeCompare(b.id))) {
    if (hasType(node, ["sc:PrivacyLabel"])) {
      const s = artifactSource(node, "label");
      if (s) sources.push(s);
    } else if (hasType(node, ["sc:PrivacyPolicy"])) {
      const s = artifactSource(node, "policy");
      if (s) sources.push(s);
    }
  }
  ctx.cache.set("privacy:sources", sources);
  return sources;
}

const applies = (source: DisclosureSource, d: DetectedCollection): boolean => source.platforms.some((p) => d.platforms.includes(p));

function missingName(source: DisclosureSource, type: string): string {
  if (source.kind === "manifest") return appleDataTypeKey(type as AppleDataType);
  if (source.vocabulary === "play") return `"${PLAY_CATEGORY[type as AppleDataType] ?? type}"`;
  return type;
}

function detected(graph: Graph, ctx: RuleContext): DetectedCollection[] {
  const cached = ctx.cache.get("privacy:detected") as DetectedCollection[] | undefined;
  if (cached) return cached;
  const d = detectCollection(graph);
  ctx.cache.set("privacy:detected", d);
  return d;
}

const privacyDisclosed: CustomRule = {
  id: "privacy-disclosed",
  pack: PACK,
  severity: "error",
  description: "Every data type a detected SDK collects is declared in every applicable disclosure (manifest, store labels, policy)",
  check(graph, ctx) {
    const out: Finding[] = [];
    const sources = disclosureSources(graph, ctx);
    for (const s of sources) {
      if (s.error) out.push({ node: s.id, message: `cannot parse ${s.name}: ${s.error}`, file: s.file });
    }
    for (const d of detected(graph, ctx)) {
      for (const source of sources) {
        if (source.error || !applies(source, d)) continue;
        for (const type of d.dataTypes) {
          if (source.declares.has(type)) continue;
          out.push({
            node: d.package,
            message: `${d.package} collects ${type} but ${source.name} does not declare ${missingName(source, type)}`,
            file: source.file,
          });
        }
      }
    }
    return out;
  },
};

const privacyTracking: CustomRule = {
  id: "privacy-tracking",
  pack: PACK,
  severity: "error",
  description: "SDKs that track users (ATT sense) require NSPrivacyTracking = true and matching labels",
  check(graph, ctx) {
    const out: Finding[] = [];
    const sources = disclosureSources(graph, ctx);
    for (const d of detected(graph, ctx).filter((x) => x.tracking)) {
      for (const source of sources) {
        if (source.error || !applies(source, d)) continue;
        if (source.kind === "manifest" && source.tracking !== true) {
          const state = source.tracking === false ? "sets NSPrivacyTracking to false" : "does not set NSPrivacyTracking";
          out.push({ node: d.package, message: `${d.package} tracks users but ${source.name} ${state}`, file: source.file });
        } else if (source.kind !== "manifest" && source.tracking === false) {
          out.push({ node: d.package, message: `${d.package} tracks users but ${source.name} declares no tracking`, file: source.file });
        }
      }
    }
    return out;
  },
};

const PLATFORM_HINT: Record<Platform, string> = {
  ios: "a PrivacyInfo.xcprivacy or an App Store privacy label (sc:PrivacyLabel)",
  android: "a Play Data Safety label (sc:PrivacyLabel, platform android)",
  web: "a privacy policy (sc:PrivacyPolicy with meta.declares)",
  server: "a privacy policy (sc:PrivacyPolicy with meta.declares)",
};

const privacyDisclosureExists: CustomRule = {
  id: "privacy-disclosure-exists",
  pack: PACK,
  severity: "warn",
  description: "Apps whose SDKs collect data have at least one disclosure per platform",
  check(graph, ctx) {
    // an unparseable manifest still exists; privacy-disclosed reports the parse error
    const sources = disclosureSources(graph, ctx);
    const uncovered = new Map<Platform, DetectedCollection[]>();
    for (const d of detected(graph, ctx)) {
      if (d.dataTypes.length === 0) continue;
      for (const p of d.platforms) {
        if (sources.some((s) => s.platforms.includes(p))) continue;
        uncovered.set(p, [...(uncovered.get(p) ?? []), d]);
      }
    }
    const out: Finding[] = [];
    for (const [platform, ds] of [...uncovered].sort(([a], [b]) => a.localeCompare(b))) {
      const pkgs = [...new Set(ds.map((d) => d.package))];
      const types = [...new Set(ds.flatMap((d) => d.dataTypes))].sort();
      out.push({
        node: ds[0]!.package,
        message: `${pkgs.join(", ")} collect ${types.join(", ")} on ${platform} but no disclosure exists; add ${PLATFORM_HINT[platform]}`,
      });
    }
    return out;
  },
};

export const pack: RulePack = {
  id: PACK,
  description: "Privacy drift: SDK data collection vs PrivacyInfo.xcprivacy, App Store / Play labels and privacy policy",
  rules: [privacyDisclosed, privacyTracking, privacyDisclosureExists],
};
