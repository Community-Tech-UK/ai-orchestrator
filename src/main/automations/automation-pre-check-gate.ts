/**
 * A15 / 8b — the pre-check gate for automation runs.
 *
 * Called from `AutomationRunner.dispatchRun` before any instance is created.
 * It runs only when the run's snapshot carries a `preCheck` AND the trigger is
 * `scheduled` or `catchUp` ("Run now" and webhooks always run). Returns `true`
 * when it ended the run and dispatch must stop.
 *
 * Baseline semantics: the check's capture becomes the comparison baseline only
 * after the AI run it started succeeds (see `automation-runner-terminal.ts`).
 */

import type {
  AutomationRun,
  ClaimedAutomationRun,
} from '../../shared/types/automation.types';
import type { AutomationNotificationKind } from '../../shared/types/notification.types';
import { AutomationPreCheckPolicySchema } from '@contracts/schemas/automation';
import type { AutomationStore } from './automation-store';
import { getAutomationCheckStore } from './automation-check-store';
import { runAutomationPreCheck } from './automation-pre-check';
import { getNotificationService } from '../notifications/notification-service';
import { getLogger } from '../logging/logger';

const logger = getLogger('AutomationPreCheckGate');

export interface AutomationPreCheckGateHost {
  store: Pick<AutomationStore, 'terminalizeRun' | 'markSeen' | 'getRun'>;
  now: () => number;
  handleTerminalRun(run: AutomationRun, options?: { retryable?: boolean }): void;
}

export type AutomationPreCheckGate = (
  claimed: ClaimedAutomationRun,
  host: AutomationPreCheckGateHost,
) => Promise<boolean>;

function formatCheckTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function notifyCheckFailing(claimed: ClaimedAutomationRun, stopped: boolean): void {
  try {
    getNotificationService().notify({
      kind: 'automation-check-failed' satisfies AutomationNotificationKind,
      title: 'Automation check failing',
      body: `${claimed.snapshot.name}: its check stopped with an error, so ${
        stopped ? 'the run stopped' : 'the AI did the full job'
      }. Fix the check on the Automations page.`,
      urgency: 'normal',
      fingerprintFields: { automationId: claimed.run.automationId },
    });
  } catch {
    // Notification failure must never affect run bookkeeping.
  }
}

export const runAutomationPreCheckGate: AutomationPreCheckGate = async (claimed, host) => {
  const check = claimed.snapshot.action.preCheck;
  if (!check) {
    return false;
  }
  if (claimed.run.trigger !== 'scheduled' && claimed.run.trigger !== 'catchUp') {
    // "Run now" and webhooks always run the AI.
    return false;
  }
  if ((claimed.run.attempt ?? 1) > 1) {
    // A retry already carries the change note captured by the first attempt
    // (its snapshot is copied from the original run) — never re-check.
    return false;
  }

  // Stored jobs and queued snapshots may predate current write validation.
  // Refuse incompatible checks before loading check state or spawning a shell.
  const policy = AutomationPreCheckPolicySchema.safeParse(claimed.snapshot);
  if (!policy.success) {
    const terminal = host.store.terminalizeRun(
      claimed.run.id, 'failed', policy.error.issues.map(issue => issue.message).join(' '), undefined, host.now(),
    ) ?? claimed.run;
    host.handleTerminalRun(terminal, { retryable: false });
    return true;
  }

  // Restart pause can dispatch the same first attempt again. Preserve its
  // saved result note and any pending capture, including a run-anyway failure,
  // until this run finishes instead of executing and appending the check twice.
  const current = host.store.getRun(claimed.run.id);
  if (current?.status === 'running' && (
    current.outcome === 'first-check' || current.outcome === 'changed' || current.outcome === 'check-failed'
  )) return false;

  const checkStore = getAutomationCheckStore();
  const automationId = claimed.run.automationId;
  const result = await runAutomationPreCheck(check, {
    cwd: claimed.snapshot.action.workingDirectory,
    automationId,
    store: checkStore,
    now: host.now,
  });

  if (result.kind === 'no-change') {
    checkStore.clearCheckFailure(automationId);
    checkStore.setRunOutcome(claimed.run.id, 'no-change');
    const message = `Checked at ${formatCheckTime(host.now())}: nothing changed, so the AI was not started.`;
    const terminal = host.store.terminalizeRun(
      claimed.run.id,
      'skipped',
      message,
      undefined,
      host.now(),
    ) ?? claimed.run;
    // Mark seen BEFORE the terminal run-changed event is emitted so the
    // unread badge never moves for a run where nothing happened.
    host.store.markSeen({ runId: claimed.run.id });
    const reread = host.store.getRun(claimed.run.id) ?? { ...terminal, seenAt: host.now() };
    host.handleTerminalRun(reread, { retryable: false });
    return true;
  }

  const onError = check.onError ?? 'run-anyway';
  if (result.kind === 'error') {
    checkStore.setRunOutcome(claimed.run.id, 'check-failed');
    const streak = checkStore.recordCheckFailure(automationId);
    if (streak === 1) {
      notifyCheckFailing(claimed, onError === 'stop');
    }
    if (onError === 'stop') {
      const terminal = host.store.terminalizeRun(
        claimed.run.id,
        'failed',
        'The check could not run, so this run stopped.',
        undefined,
        host.now(),
      ) ?? claimed.run;
      host.handleTerminalRun(terminal, { retryable: false });
      return true;
    }
  } else {
    checkStore.clearCheckFailure(automationId);
    checkStore.setRunOutcome(claimed.run.id, result.kind === 'first-check' ? 'first-check' : 'changed');
    checkStore.setPending(automationId, claimed.run.id, result.hash, result.output);
  }

  // The run proceeds — tell the AI what the check saw. The note is persisted
  // onto the run's snapshot so a retry carries the same change note.
  const note = result.note ?? '';
  const prompt = note ? `${claimed.snapshot.action.prompt}\n\n${note}` : claimed.snapshot.action.prompt;
  checkStore.setRunPrompt(claimed.run.id, prompt);
  claimed.snapshot.action.prompt = prompt;
  logger.info('Automation pre-check passed', {
    automationId,
    runId: claimed.run.id,
    kind: result.kind,
    error: result.error,
  });
  return false;
};
