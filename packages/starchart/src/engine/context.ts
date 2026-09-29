import type { AdapterContext } from "../adapters/types.js";
import type { Project } from "../project.js";

export interface EngineIO {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Adapter settings from config, with the project's `site` available to every adapter. */
export function adapterSettings(project: Project, adapterId: string): Record<string, unknown> {
  const { adapters, site } = project.loaded.config;
  return { ...(site !== undefined ? { site } : {}), ...(adapters[adapterId] ?? {}) };
}

/** Fact values as of the last lock: what the world should currently show. */
export function previousValues(project: Project): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(project.lock.facts)) out[id] = entry.value;
  return out;
}

export function adapterContext(project: Project, adapterId: string, io: EngineIO & { dryRun?: boolean } = {}): AdapterContext {
  return {
    root: project.root,
    graph: project.graph,
    settings: adapterSettings(project, adapterId),
    env: io.env ?? process.env,
    fetch: io.fetch ?? globalThis.fetch,
    previousValues: previousValues(project),
    dryRun: io.dryRun ?? false,
  };
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving result order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
