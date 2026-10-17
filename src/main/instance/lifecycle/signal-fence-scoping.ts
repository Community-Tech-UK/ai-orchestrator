/**
 * Per-instance "signal fence off" registry (macOS).
 *
 * Same shape and reasoning as `contained-execution-scoping.ts`: spawn-time
 * consumers (the adapter factory, the warm-start preflight, the spawn-worker
 * offload choice) hold no instance state, so `createInstance` writes the
 * override here, every spawn/respawn path reads it back by instance id, and
 * `InstanceManager` clears it on removal. Bounded as a safety net.
 *
 * Deliberately in memory only: after an app restart a restored session gets
 * the fence back, which is the safe default.
 */

const MAX_ENTRIES = 1000;

const unfencedInstances = new Set<string>();

/** `signalFence === false` turns the fence off for this instance; anything else leaves it on. */
export function setInstanceSignalFence(instanceId: string, signalFence: boolean | undefined): void {
  unfencedInstances.delete(instanceId);
  if (signalFence !== false) return;
  unfencedInstances.add(instanceId);
  if (unfencedInstances.size > MAX_ENTRIES) {
    const oldest = unfencedInstances.values().next().value;
    if (oldest !== undefined) unfencedInstances.delete(oldest);
  }
}

export function isInstanceSignalFenceDisabled(instanceId: string | undefined): boolean {
  return instanceId !== undefined && unfencedInstances.has(instanceId);
}

export function removeInstanceSignalFence(instanceId: string): void {
  unfencedInstances.delete(instanceId);
}

export function _resetSignalFenceScopingForTesting(): void {
  unfencedInstances.clear();
}
