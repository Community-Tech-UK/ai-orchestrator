import type { Instance } from '../../shared/types/instance.types';
import type { HostProcessRuntimeHooks } from './host-process-inspector';

/** The slice of InstanceManager the host process tools read. */
export interface HostProcessInstanceSource {
  getInstance(id: string): Pick<Instance, 'status'> | undefined;
  getAllInstances(): ReadonlyArray<Pick<Instance, 'id' | 'processId'>>;
  getAdapter(id: string): unknown;
}

// A session is gone only once it is terminated or failed, or Harness no longer knows it.
// Hibernated, errored and respawning sessions can come back, so their leftovers stay protected.
const DEAD_STATUSES = new Set<string>(['terminated', 'failed']);

function adapterPid(adapter: unknown): number | null {
  const getPid = (adapter as { getPid?: unknown } | null | undefined)?.getPid;
  if (typeof getPid !== 'function') return null;
  try {
    const pid: unknown = getPid.call(adapter);
    return typeof pid === 'number' ? pid : null;
  } catch {
    return null;
  }
}

export function createInstanceManagerHostProcessHooks(source: HostProcessInstanceSource): HostProcessRuntimeHooks {
  return {
    isInstanceLive: (instanceId) => {
      const instance = source.getInstance(instanceId);
      return instance !== undefined && !DEAD_STATUSES.has(instance.status);
    },
    getLiveSessionPids: () => {
      const pids = new Set<number>();
      for (const instance of source.getAllInstances()) {
        if (typeof instance.processId === 'number') pids.add(instance.processId);
        const pid = adapterPid(source.getAdapter(instance.id));
        if (pid !== null) pids.add(pid);
      }
      return pids;
    },
  };
}
