import type { Adapter } from "./types.js";

/** CONTRACT PLACEHOLDER — replaced by the adapters implementation. */
const adapters = new Map<string, Adapter>();

export function registerAdapter(adapter: Adapter): void {
  adapters.set(adapter.id, adapter);
}

export function getAdapter(id: string): Adapter | undefined {
  return adapters.get(id);
}

export function listAdapters(): Adapter[] {
  return [...adapters.values()];
}

/** Whether the adapter can write. Settings may disable writes (`adapters.<id>.write: false`). */
export function canWrite(id: string, settings?: Record<string, Record<string, unknown>>): boolean {
  if (settings?.[id]?.write === false) return false;
  return adapters.get(id)?.capabilities.write === true;
}
