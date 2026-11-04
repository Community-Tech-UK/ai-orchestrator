import type { CliAdapter } from '../cli/adapters/adapter-factory';

// Stop intent belongs to this runtime, not a reusable instance id or a transient
// UI wait reason. A refused stop keeps the fence until the owner retries; a
// replacement adapter never inherits it. Explicit remote reuse clears it only
// after the previous runtime has stopped. Weak references need no cleanup map.
const stoppingAdapters = new WeakSet<object>();

export function markAdapterStopping(adapter: CliAdapter): void {
  stoppingAdapters.add(adapter);
}

export function isAdapterStopping(adapter: object): boolean {
  return stoppingAdapters.has(adapter);
}

export function clearAdapterStopping(adapter: CliAdapter): void {
  stoppingAdapters.delete(adapter);
}
