import { subscribeCostAttribution } from '../core/system/cost-attribution';
import { getLogger } from '../logging/logger';
import type { InstanceManager } from '../instance/instance-manager';
import type { AutomationAction, AutomationSchedule } from '../../shared/types/automation.types';
import { withRunLimits } from './automation-run-policy';

const logger = getLogger('AutomationThreadTurnLimit');
const MAX_TIMEOUT_MS = 2_147_000_000;

type ThreadTurnHost = Pick<InstanceManager, 'interruptInstance' | 'waitForInstanceSettled'>;

/**
 * A wake-up into an existing conversation ends its automation run as soon as the
 * prompt is delivered, so the run limits never see the turn that follows. Bound
 * that turn by the same minutes and processed-token limits a new scheduled
 * session gets. At the limit the turn is interrupted, not the conversation
 * closed, so the person can carry on from where it stopped.
 */
export function boundThreadWakeupTurn(host: ThreadTurnHost, instanceId: string, sentAt: number,
  action: AutomationAction, schedule: AutomationSchedule): void {
  const { maxRunMinutes, maxProcessedTokens } = withRunLimits(action, schedule);
  const abort = new AbortController();
  let processed = 0;
  let stopped = false;
  const stop = (reason: string): void => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    unsubscribe();
    logger.warn('Stopping a thread turn that a wake-up started', { instanceId, reason });
    host.interruptInstance(instanceId);
  };
  const unsubscribe = subscribeCostAttribution(record => {
    if (record.source !== 'instance-turn' || record.instanceId !== instanceId || !record.usage) return;
    // Output is billed separately; the shared processed metric is input plus both caches.
    for (const count of [record.usage.inputTokens, record.usage.cacheReadTokens, record.usage.cacheWriteTokens]) {
      if (Number.isFinite(count) && count! > 0) processed += count!;
    }
    if (processed > maxProcessedTokens!) stop('Stopped: token cap');
  });
  host.waitForInstanceSettled(instanceId, { afterTimestamp: sentAt, timeoutMs: Math.min(maxRunMinutes! * 60_000, MAX_TIMEOUT_MS), signal: abort.signal })
    .then(() => { if (!stopped) { stopped = true; unsubscribe(); } })
    .catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Timed out')) stop(`Stopped after ${maxRunMinutes} minutes`);
      else if (!stopped) { stopped = true; unsubscribe(); logger.warn('Could not watch a thread turn for its limit', { instanceId, error }); }
    });
}
