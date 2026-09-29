import { appstoreAdapter } from "./appstore.js";
import { fsAdapter } from "./fs.js";
import { stripeAdapter } from "./stripe.js";
import type { GraphNode } from "../core/model.js";
import type { Adapter } from "./types.js";
import { urlAdapter } from "./url.js";

/** Adapters shipped with STARCHART, registered on import. */
export const builtinAdapters: readonly Adapter[] = [fsAdapter, urlAdapter, stripeAdapter, appstoreAdapter];

const adapters = new Map<string, Adapter>(builtinAdapters.map((a) => [a.id, a]));

/** Registers (or replaces) an adapter by id. */
export function registerAdapter(adapter: Adapter): void {
  adapters.set(adapter.id, adapter);
}

export function getAdapter(id: string): Adapter | undefined {
  return adapters.get(id);
}

export function listAdapters(): Adapter[] {
  return [...adapters.values()];
}

/** Adapters that write only inside the repo; everything else touches external systems. */
const LOCAL_ADAPTERS = new Set(["fs"]);

/**
 * Whether the adapter can write. Local adapters write unless `adapters.<id>.write: false`;
 * adapters that touch external systems (Stripe, App Store, …) are opt-in via `write: true`.
 */
export function canWrite(id: string, settings?: Record<string, Record<string, unknown>>, node?: GraphNode): boolean {
  const adapter = adapters.get(id);
  if (adapter?.capabilities.write !== true || typeof adapter.apply !== "function") return false;
  if (node && adapter.canApply && !adapter.canApply(node)) return false;
  const setting = settings?.[id]?.write;
  return LOCAL_ADAPTERS.has(id) ? setting !== false : setting === true;
}
