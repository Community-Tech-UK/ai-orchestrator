/**
 * Plan Queue verifier reminders.
 *
 * A verifier's review ends with its turn. Verifiers often end a turn while their
 * own background gates still run, or before finding the Harness verdict tool. A
 * clean turn with no verdict therefore gets a bounded follow-up turn on the same
 * session before the item flow counts the round as unusable.
 */

import { AUTOMATION_FAILURE_STATUSES } from '../../shared/types/instance-status-policy';
import { getLogger } from '../logging/logger';
import { sameTree, snapshotTree, type TreeSnapshot } from './plan-queue-git';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueTurnOutcome } from './plan-queue-instance-tracker';
import { buildVerifierReminderPrompt } from './plan-queue-prompts';
import type { PlanQueueItem } from './plan-queue.types';

const logger = getLogger('PlanQueueVerifierReminder');

/** Follow-up turns a verifier gets after ending a turn without a verdict. */
export const MAX_VERIFIER_REMINDERS = 2;

export class PlanQueueVerifierReminders {
  /** Reminder turns already sent, keyed by verifier instance. */
  private readonly sent = new Map<string, number>();

  constructor(
    private readonly host: PlanQueueFlowHost,
    /** Where a reminder that failed (not delivered, or its turn failed) is reported, as the verifier's outcome. */
    private readonly onSendFailed: (instanceId: string, outcome: PlanQueueTurnOutcome) => void,
  ) {}

  /**
   * Start the next reminder turn when the turn completed cleanly with no verdict, the
   * run is not paused, the session is usable and the tree is unchanged. Returns true
   * when one was started; otherwise the caller decides the round as before.
   */
  async remind(item: PlanQueueItem, instanceId: string, outcome: PlanQueueTurnOutcome, hasVerdict: boolean, before: TreeSnapshot | undefined): Promise<boolean> {
    if (outcome.kind !== 'turn-complete' || hasVerdict) return false;
    const count = this.sent.get(instanceId) ?? 0;
    if (count >= MAX_VERIFIER_REMINDERS || this.host.getRun(item.runId).status === 'paused') return false;
    const verifier = this.host.instances.getInstance(instanceId);
    if (!verifier || AUTOMATION_FAILURE_STATUSES.has(verifier.status)) return false;
    try {
      if (before && item.worktreePath && !sameTree(before, await snapshotTree(item.worktreePath))) return false;
    } catch (error) {
      // The caller's normal path decides the round, and reports a tree it cannot read.
      logger.warn('Plan queue: could not check the tree before reminding the verifier', { itemId: item.id, instanceId, error: errorMessage(error) });
      return false;
    }
    this.sent.set(instanceId, count + 1);
    this.host.tracker.beginTurn(instanceId);
    const prompt = buildVerifierReminderPrompt(item.id, count + 1, MAX_VERIFIER_REMINDERS);
    // Not awaited, like a verifier's first turn: some adapters (Codex app-server) settle
    // sendInput only when the turn ends, and the caller holds the item lock that Pause
    // and Cancel need to stop this verifier.
    void this.host.instances.sendInput(instanceId, prompt, undefined, { automatedInput: true, internalSource: 'plan-queue' })
      .catch((error: unknown) => {
        if (this.host.tracker.isShuttingDown()) return;
        logger.warn('Plan queue: could not remind the verifier', { itemId: item.id, instanceId, error: errorMessage(error) });
        this.onSendFailed(instanceId, { kind: 'failed', reason: `its reminder turn failed: ${errorMessage(error)}` });
      });
    return true;
  }

  forget(instanceId: string): void {
    this.sent.delete(instanceId);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
