import { copilotNeedsContextRecycle } from '../../shared/utils/copilot-usage';
import type { PlanQueueInstancePort, PlanQueueInstanceRecord } from './plan-queue-host';

/** Refresh the provider conversation, never the queue job, branch or owning runtime instance. */
export async function recycleQueueCopilotSession(
  instances: Pick<PlanQueueInstancePort, 'restartFreshInstance' | 'getInstance'>,
  worker: PlanQueueInstanceRecord,
  beforeRestart: () => void,
): Promise<boolean> {
  if (worker.provider !== 'copilot' || !copilotNeedsContextRecycle(worker.contextUsage?.copilotUsage)) return false;
  beforeRestart();
  await instances.restartFreshInstance(worker.id);
  const fresh = instances.getInstance(worker.id);
  if (!fresh || fresh.id !== worker.id || fresh.status !== 'idle') throw new Error('Copilot context restart did not leave the owning queue session ready');
  return true;
}
