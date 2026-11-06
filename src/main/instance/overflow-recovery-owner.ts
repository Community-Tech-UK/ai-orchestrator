import type { Instance } from '../../shared/types/instance.types';
import type { CompactionRecoveryOwner } from '../context/compaction-execution-options';
import { captureInstanceRecoveryEpoch, isInstanceRecoveryEpochCurrent } from './instance-turn-ending-state';

/** Default authority for overflow hooks with no resumable input (including the empty-response breaker). */
export function captureOverflowRecoveryOwner(
  instanceId: string,
  getInstance: (id: string) => Instance | undefined,
  getAdapter: (id: string) => unknown,
): CompactionRecoveryOwner {
  const instance = getInstance(instanceId);
  const epoch = captureInstanceRecoveryEpoch(instanceId);
  const adapter = getAdapter(instanceId);
  const requestCount = instance?.requestCount;
  const sessionId = instance?.sessionId;
  const provider = instance?.provider;
  const assertCurrent = (): void => {
    if (instance && getInstance(instanceId) === instance && isInstanceRecoveryEpochCurrent(instanceId, epoch)
      && !['interrupting', 'cancelling', 'cancelled', 'terminated', 'failed', 'error', 'superseded', 'hibernated'].includes(instance.status)) return;
    const error = new Error('Overflow recovery no longer owns the instance');
    error.name = 'AbortError';
    throw error;
  };
  return {
    assertCurrent,
    assertProviderDispatchCurrent: assertCurrent,
    assertBeforeRestart: () => {
      assertCurrent();
      if (instance?.requestCount === requestCount && instance?.sessionId === sessionId
        && instance?.provider === provider && getAdapter(instanceId) === adapter) return;
      const error = new Error('Overflow recovery provider changed before restart');
      error.name = 'AbortError';
      throw error;
    },
  };
}
