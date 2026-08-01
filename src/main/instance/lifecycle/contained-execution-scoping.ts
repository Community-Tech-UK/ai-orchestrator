/**
 * WS-C7 — per-instance contained-execution-profile registry.
 *
 * Same shape and reasoning as `hardened-mode-scoping.ts`: spawn-time
 * consumers (the adapter factory) hold no instance state, so `createInstance`
 * writes the flag here, every spawn/respawn path reads it back by instance
 * id (via `createCliAdapter` in adapter-factory.ts, which folds `filterEnv:
 * true` into the spawn options), and `InstanceManager` clears it on removal.
 * Bounded as a safety net.
 */

const MAX_ENTRIES = 1000;

const containedInstances = new Set<string>();

export function setInstanceContainedExecution(instanceId: string, contained: boolean | undefined): void {
  if (!contained) {
    containedInstances.delete(instanceId);
    return;
  }
  containedInstances.delete(instanceId);
  containedInstances.add(instanceId);
  if (containedInstances.size > MAX_ENTRIES) {
    const oldest = containedInstances.values().next().value;
    if (oldest !== undefined) containedInstances.delete(oldest);
  }
}

export function isInstanceContainedExecution(instanceId: string | undefined): boolean {
  return instanceId !== undefined && containedInstances.has(instanceId);
}

export function removeInstanceContainedExecution(instanceId: string): void {
  containedInstances.delete(instanceId);
}

export function _resetContainedExecutionScopingForTesting(): void {
  containedInstances.clear();
}
