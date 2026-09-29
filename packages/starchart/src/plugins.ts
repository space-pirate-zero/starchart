import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerAdapter } from "./adapters/registry.js";
import type { Adapter } from "./adapters/types.js";
import { ConfigError } from "./config/load.js";
import type { RulePack } from "./rules/engine.js";
import { registerPack } from "./rules/packs/index.js";

/** What a plugin module exports (named, or on its default export). */
export interface StarchartPlugin {
  adapters?: Adapter[];
  packs?: RulePack[];
}

const loaded = new Map<string, StarchartPlugin>();

/**
 * Imports each plugin module and registers its adapters and rule packs. A module is loaded once
 * per process. Relative specifiers resolve from the project root; bare ones from its node_modules.
 */
export async function loadPlugins(root: string, specifiers: string[]): Promise<StarchartPlugin[]> {
  const out: StarchartPlugin[] = [];
  for (const spec of specifiers) {
    const path = resolvePlugin(root, spec);
    let plugin = loaded.get(path);
    if (!plugin) {
      let mod: Record<string, unknown>;
      try {
        mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
      } catch (error) {
        throw new ConfigError(`plugin "${spec}" failed to load: ${error instanceof Error ? error.message : String(error)}`);
      }
      plugin = asPlugin(spec, mod);
      for (const adapter of plugin.adapters ?? []) registerAdapter(adapter);
      for (const pack of plugin.packs ?? []) registerPack(pack);
      loaded.set(path, plugin);
    }
    out.push(plugin);
  }
  return out;
}

function resolvePlugin(root: string, spec: string): string {
  if (spec.startsWith(".") || isAbsolute(spec)) return resolve(root, spec);
  try {
    return createRequire(join(root, "package.json")).resolve(spec);
  } catch {
    throw new ConfigError(`plugin "${spec}" not found from ${root}; install it or use a relative path`);
  }
}

function asPlugin(spec: string, mod: Record<string, unknown>): StarchartPlugin {
  const source = (mod.adapters || mod.packs ? mod : (mod.default as Record<string, unknown> | undefined)) ?? {};
  const adapters = source.adapters;
  const packs = source.packs;
  if (adapters !== undefined && !Array.isArray(adapters)) throw new ConfigError(`plugin "${spec}": "adapters" must be an array`);
  if (packs !== undefined && !Array.isArray(packs)) throw new ConfigError(`plugin "${spec}": "packs" must be an array`);
  if (!adapters && !packs) throw new ConfigError(`plugin "${spec}" exports neither "adapters" nor "packs"`);
  for (const a of (adapters ?? []) as Adapter[]) {
    if (!a || typeof a.id !== "string" || typeof a.audit !== "function") throw new ConfigError(`plugin "${spec}": every adapter needs an id and an audit() function`);
  }
  for (const p of (packs ?? []) as RulePack[]) {
    if (!p || typeof p.id !== "string" || !Array.isArray(p.rules)) throw new ConfigError(`plugin "${spec}": every pack needs an id and a rules array`);
  }
  return { adapters: adapters as Adapter[] | undefined, packs: packs as RulePack[] | undefined };
}
