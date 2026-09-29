import type { Rule, RulePack } from "../engine.js";
import { pack as appstore } from "./appstore.js";
import { pack as core } from "./core.js";
import { pack as privacy } from "./privacy.js";
import { pack as seo } from "./seo.js";

/** Built-in rule packs, keyed by id. */
export const PACKS: Readonly<Record<string, RulePack>> = { core, appstore, privacy, seo };

/** Packs contributed by plugins (see `plugins:` in config). Built-ins cannot be replaced. */
const registered = new Map<string, RulePack>();

export function registerPack(pack: RulePack): void {
  if (pack.id in PACKS) throw new Error(`rule pack "${pack.id}" is built in and cannot be replaced`);
  registered.set(pack.id, pack);
}

/**
 * Rules for the given pack ids (duplicates ignored, order preserved). Accepts bare ids or
 * the published names (`@starchart/pack-appstore`, `pack-appstore`).
 */
export function loadPacks(ids: string[]): { rules: Rule[]; unknown: string[] } {
  const rules: Rule[] = [];
  const unknown: string[] = [];
  const loaded = new Set<string>();
  for (const raw of ids) {
    const id = raw.replace(/^@starchart\//, "").replace(/^pack-/, "");
    const pack = PACKS[id] ?? registered.get(id) ?? registered.get(raw);
    if (!pack) {
      if (!unknown.includes(raw)) unknown.push(raw);
      continue;
    }
    if (loaded.has(id)) continue;
    loaded.add(id);
    rules.push(...pack.rules);
  }
  return { rules, unknown };
}

export { detectCollection, parsePrivacyManifest, findPrivacyManifests, disclosureSources } from "./privacy.js";
export type { DetectedCollection, PrivacyManifest, DisclosureSource, Platform } from "./privacy.js";
export { PRIVACY_CATALOG, normalizeDataType } from "./privacy-catalog.js";
export type { SdkCatalogEntry, AppleDataType } from "./privacy-catalog.js";
