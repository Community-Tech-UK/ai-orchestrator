import type { Instance } from '../../../shared/types/instance.types';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import { isMainChatSession } from './main-chat-session-scope';

/** Spawn-time registry: identity is preserved across respawns; fresh loop adapters have no entry. */
const MAX_ENTRIES = 1_000;
const taskToolInstances = new Set<string>();

export function setInstanceTaskTools(instanceId: string, enabled: boolean | undefined): void {
  taskToolInstances.delete(instanceId);
  if (!enabled) return;
  taskToolInstances.add(instanceId);
  if (taskToolInstances.size > MAX_ENTRIES) {
    const oldest = taskToolInstances.values().next().value;
    if (oldest !== undefined) taskToolInstances.delete(oldest);
  }
}

export function isInstanceTaskTools(instanceId: string | undefined): boolean {
  return instanceId !== undefined && taskToolInstances.has(instanceId);
}

export function removeInstanceTaskTools(instanceId: string): void {
  taskToolInstances.delete(instanceId);
}

export function _resetTaskToolsScopingForTesting(): void {
  taskToolInstances.clear();
}

/**
 * Evaluate only with the resolved placement/provider, never the builder's initial local placeholder.
 * Re-evaluating at adapter construction makes a changed setting apply to restarted sessions.
 * A main chat that borrows its existing adapter for a loop retains that process's tools.
 */
export function configureInstanceTaskTools(
  instance: Pick<Instance, 'id' | 'provider' | 'parentId' | 'executionLocation' | 'metadata'>,
  enabled: boolean,
  executionLocation: ExecutionLocation = instance.executionLocation,
  provider: string = instance.provider,
): void {
  setInstanceTaskTools(instance.id, enabled === true && provider === 'claude'
    && isMainChatSession({ ...instance, executionLocation }, false));
}
