import type { InstanceManager } from '../instance/instance-manager';
import type { AutomationStore } from './automation-store';
import { automationInvocations } from './automation-invocation-context';

/** Caller identity is supplied by the authenticated RPC connection or a runtime-owned channel context. */
export function markAutomationDelivery(callerId: string, manager: Pick<InstanceManager, 'getInstance'>, store: Pick<AutomationStore, 'getRun' | 'getRunByInstance' | 'markDeliveryStarted'>): void {
  const invocation = automationInvocations.get(callerId);
  let run = invocation ? store.getRun(invocation.runId) : null;
  let current = manager.getInstance(callerId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const parentId = current.parentId ?? current.metadata?.['spawnParentInstanceId'];
    if (typeof parentId === 'string') { current = manager.getInstance(parentId); continue; }
    run = store.getRunByInstance(current.id);
    const metadataRunId = current.metadata?.['automationRunId'];
    if (!run && typeof metadataRunId === 'string') {
      const candidate = store.getRun(metadataRunId);
      if (candidate?.instanceId === null || candidate?.instanceId === current.id) run = candidate;
    }
    break;
  }
  if (run?.status === 'running' && run.configSnapshot?.destination.kind === 'newInstance' && !run.configSnapshot.action.systemAction) {
    store.markDeliveryStarted(run.id);
  }
}
