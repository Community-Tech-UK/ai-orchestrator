import { getSettingsManager } from '../core/config/settings-manager';
import type { Automation, CreateAutomationInput } from '../../shared/types/automation.types';
import {
  computeNextFireAt,
  getAutomationRunner,
  getAutomationStore,
} from './index';
import { getAutomationEvents } from './automation-events';

export async function handlePastOneTimeAutomation(automation: Automation): Promise<void> {
  if (automation.schedule.type !== 'oneTime' || automation.schedule.runAt > Date.now()) {
    return;
  }

  const store = getAutomationStore();
  const events = getAutomationEvents();
  if (automation.missedRunPolicy === 'runOnce') {
    await getAutomationRunner().fire(automation.id, {
      trigger: 'catchUp',
      scheduledAt: automation.schedule.runAt,
    });
    return;
  }

  const reason = automation.missedRunPolicy === 'notify'
    ? 'One-time automation was already in the past when created'
    : 'Past one-time automation skipped by missed-run policy';
  const run = store.recordSkipped(automation, 'catchUp', automation.schedule.runAt, reason);
  store.completeOneTime(automation.id);
  const completed = await store.get(automation.id);
  events.emitRunChanged({ automationId: automation.id, run });
  events.emitRunTerminal({ automationId: automation.id, runId: run.id, status: 'skipped' });
  events.emitChanged({ automation: completed, automationId: automation.id, type: 'updated' });
  events.emitScheduleDeactivated({ automationId: automation.id });
}

export async function createAutomationWithScheduling(input: CreateAutomationInput): Promise<Automation | null> {
  const store = getAutomationStore();
  const events = getAutomationEvents();
  const now = Date.now();
  const missedRunPolicy = input.missedRunPolicy ?? getSettingsManager().get('defaultMissedRunPolicy');
  const nextFireAt = input.enabled === false ? null : computeNextFireAt(input.schedule, now);
  const automation = await store.create({
    ...input,
    missedRunPolicy,
    action: input.action,
  }, nextFireAt, now);

  events.emitChanged({ automation, automationId: automation.id, type: 'created' });
  await handlePastOneTimeAutomation(automation);
  return store.get(automation.id);
}
