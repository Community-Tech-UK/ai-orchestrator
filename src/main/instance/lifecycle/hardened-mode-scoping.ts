/**
 * Fable WS13 — per-instance hardened-mode (Seatbelt) registry.
 *
 * Same shape and reasoning as `browser-tool-scoping.ts`: spawn-time consumers
 * (the adapter factory) hold no instance state, so `createInstance` writes the
 * flag here, every spawn/respawn path reads it back by instance id, and
 * `InstanceManager` clears it on removal. Bounded as a safety net.
 *
 * `extraWritableRoots` are session-scoped user grants from the allow-and-retry
 * flow ("the sandbox blocked /x — allow it?"); the factory appends them to the
 * defaults on the next spawn, so a restart after a grant rebuilds the jail
 * with the approved path writable.
 */

const MAX_ENTRIES = 1000;

interface HardenedEntry {
  extraWritableRoots: string[];
}

const hardenedInstances = new Map<string, HardenedEntry>();

export function setInstanceHardened(instanceId: string, hardened: boolean | undefined): void {
  if (!hardened) {
    hardenedInstances.delete(instanceId);
    return;
  }
  const existing = hardenedInstances.get(instanceId);
  hardenedInstances.delete(instanceId);
  hardenedInstances.set(instanceId, existing ?? { extraWritableRoots: [] });
  if (hardenedInstances.size > MAX_ENTRIES) {
    const oldest = hardenedInstances.keys().next().value;
    if (oldest !== undefined) hardenedInstances.delete(oldest);
  }
}

export function isInstanceHardened(instanceId: string | undefined): boolean {
  return instanceId !== undefined && hardenedInstances.has(instanceId);
}

/**
 * Session-scoped "allow this path" grant. Returns false when the instance is
 * not hardened (nothing to grant against). Takes effect on the next spawn.
 */
export function addInstanceWritableRoot(instanceId: string, root: string): boolean {
  const entry = hardenedInstances.get(instanceId);
  if (!entry) return false;
  if (!entry.extraWritableRoots.includes(root)) {
    entry.extraWritableRoots.push(root);
  }
  return true;
}

export function getInstanceExtraWritableRoots(instanceId: string | undefined): string[] {
  if (instanceId === undefined) return [];
  return [...(hardenedInstances.get(instanceId)?.extraWritableRoots ?? [])];
}

export function removeInstanceHardened(instanceId: string): void {
  hardenedInstances.delete(instanceId);
}

export function _resetHardenedModeScopingForTesting(): void {
  hardenedInstances.clear();
}
