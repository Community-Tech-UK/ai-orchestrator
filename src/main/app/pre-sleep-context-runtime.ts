import type { Automation } from '../../shared/types/automation.types';
import { getClaudeCacheLifetime } from '../cli/adapters/claude-cache-lifetime';
import { getAutomationStore } from '../automations';
import { getAutomationEvents } from '../automations/automation-events';
import { getContextEngine } from '../context/context-engine';
import { PreSleepContext, setPreSleepContext, type PreSleepRequest } from '../context/pre-sleep-context';
import type { InstanceManager } from '../instance/instance-manager';
import { getInstanceAsyncWorkRegistry } from '../instance/instance-async-work-registry';
import { getSelfWakeupTracker } from '../instance/self-wakeup-tracker';

/**
 * A scheduled wake-up of an existing chat (or a loop's chat) is a known sleep: the time the
 * session will next be used is `nextFireAt`. Provider-limit resumes carry a system action and
 * are left out: the account is out of allowance, so a compaction could not run.
 */
export function wakeUpOf(automation: Automation | null | undefined): { instanceId: string; wakeAt: number } | null {
  if (!automation || !automation.enabled || !automation.active) return null;
  if (automation.destination.kind !== 'thread' || automation.action.systemAction) return null;
  if (typeof automation.nextFireAt !== 'number' || !Number.isFinite(automation.nextFireAt)) return null;
  return { instanceId: automation.destination.instanceId, wakeAt: automation.nextFireAt };
}

/** Wire the pre-sleep compaction into the running app. Returns a function that detaches it. */
export function setupPreSleepContext(instanceManager: InstanceManager): () => void {
  const service = new PreSleepContext({
    getInstance: (instanceId) => instanceManager.getInstance(instanceId),
    getCacheLifetimeMs: (instanceId) => getClaudeCacheLifetime(instanceManager.getAdapter(instanceId))?.lifetimeMs ?? null,
    hasPendingWork: (instanceId) =>
      getInstanceAsyncWorkRegistry().hasInhibitor(instanceId) || getSelfWakeupTracker().hasPending(instanceId),
    compact: async (instanceId) => (await getContextEngine().compactInstance(instanceId)).success,
  });
  setPreSleepContext(service);

  const onAutomationChanged = ({ automation, automationId }: { automation: Automation | null; automationId: string; type: string }): void => {
    const wakeUp = wakeUpOf(automation);
    if (wakeUp) {
      void service.note({ ...wakeUp, source: 'scheduled-wakeup', claimKey: automationId });
      return;
    }
    // Deleted, disabled, pointed at another session, or no longer a wake-up at
    // all: whatever this schedule had deferred must not compact anything now.
    service.revokeClaim(automationId);
  };
  const onIdle = ({ instanceId }: { instanceId: string }): void => { void service.onIdle(instanceId); };
  const onRemoved = (instanceId: string): void => service.forget(instanceId);

  const events = getAutomationEvents();
  // The scheduler armed persisted schedules before this listener existed. Register every
  // wake-up first: evaluating a distant one before a nearer one would compact needlessly.
  const restored: PreSleepRequest[] = [];
  for (const automation of getAutomationStore().listSchedulable()) {
    const wakeUp = wakeUpOf(automation);
    if (wakeUp) restored.push({ ...wakeUp, source: 'scheduled-wakeup', claimKey: automation.id });
  }
  events.on('automation:changed', onAutomationChanged);
  instanceManager.on('instance:idle', onIdle);
  instanceManager.on('instance:removed', onRemoved);
  void service.noteAll(restored);

  return () => {
    events.off('automation:changed', onAutomationChanged);
    instanceManager.off('instance:idle', onIdle);
    instanceManager.off('instance:removed', onRemoved);
    setPreSleepContext(null);
  };
}
