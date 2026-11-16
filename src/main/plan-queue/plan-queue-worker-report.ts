/**
 * Plan Queue worker completion report (`plan_queue_report_ready`, step 5.1).
 *
 * A worker finishes by calling the tool instead of just ending its turn. The report is stored on the item row,
 * cleared when the next worker turn starts (so a fix round can never reuse an old one), and, for a provider
 * on `REPORT_REQUIRED_PROVIDERS`, a turn that ends without one gets bounded reminder turns before it counts as
 * a failed worker turn. A provider off the list keeps today's signal: the turn ending.
 *
 * Reminders follow the checker's (plan-queue-verifier-reminder.ts): same session, a fixed number of follow-ups.
 */

import type { PlanQueueReportReadyArgs } from '@contracts/schemas/plan-queue';
import { AUTOMATION_FAILURE_STATUSES } from '../../shared/types/instance-status-policy';
import { getLogger } from '../logging/logger';
import { logPromptInjection } from '../logging/prompt-injection-log';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueTurnOutcome } from './plan-queue-instance-tracker';
import { WORKER_WAIT_RULE } from './plan-queue-prompts';
import { buildWorkerReminderPrompt } from './plan-queue-report-prompts';
import type { PlanQueueItem } from './plan-queue.types';
import { redactValue } from '../diagnostics/redaction';

const logger = getLogger('PlanQueueWorkerReport');

/**
 * Providers whose live check has passed: a worker on one of these must report. Every other provider keeps
 * the turn ending as its signal until its check passes (docs/plans/2026-11-04-pq-b3-report-ready_livetest.md
 * lists the steps). Add a provider here only with that check's evidence. claude, codex, cursor and opencode
 * passed on 12 November 2026. copilot has not been run (its seat is licensed for EBRD work only) and gemini
 * (the Antigravity CLI) gets no Harness tools to call (LT-1037), so both keep the turn-end signal.
 */
export const REPORT_REQUIRED_PROVIDERS: ReadonlySet<string> = new Set<string>(['claude', 'codex', 'cursor', 'opencode']);

let requiredProviders: ReadonlySet<string> = REPORT_REQUIRED_PROVIDERS;

/** Tests only: name the providers that must report; call with no argument to restore the built-in list. */
export function _setReportRequiredProvidersForTesting(providers?: ReadonlySet<string>): void {
  requiredProviders = providers ?? REPORT_REQUIRED_PROVIDERS;
}

/** Follow-up turns a worker gets after ending a turn without a report. */
export const MAX_WORKER_REMINDERS = 2;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** `plan_queue_report_ready`: only the item's current worker, while it is working, may report. */
export function recordWorkerReport(host: Pick<PlanQueueFlowHost, 'getItem' | 'save'>, callerInstanceId: string, args: PlanQueueReportReadyArgs): { accepted: true; message: string } {
  const item = host.getItem(args.item_id);
  if ((item.state !== 'working' && item.state !== 'fixing') || item.workerInstanceId !== callerInstanceId) {
    throw new Error('Only the worker currently assigned to this item may report it ready');
  }
  if (args.capability_gaps && JSON.stringify(redactValue(args.capability_gaps, { homeDir: '' })) !== JSON.stringify(args.capability_gaps)) throw new Error('Capability evidence must be redacted before it is recorded.');
  host.save({ ...item, workerReport: {
    summary: args.summary, asBuilt: args.as_built, checksRun: args.checks_run,
    deferredChecks: args.deferred_checks, followUps: args.follow_ups,
    ...(args.capability_gaps ? { capabilityGaps: args.capability_gaps } : {}),
  } });
  return { accepted: true, message: 'Report recorded. End your turn now; the coordinator hands the work over when you stop.' };
}

export class PlanQueueWorkerReports {
  /** Reminder turns already sent, keyed by worker instance. */
  private readonly sent = new Map<string, number>();

  constructor(
    private readonly host: PlanQueueFlowHost,
    /** Where a reminder that failed to send is reported, as the worker's outcome. */
    private readonly onSendFailed: (instanceId: string, outcome: PlanQueueTurnOutcome) => void,
  ) {}

  /** A new worker turn starts: it gets its full reminder allowance again. */
  beginTurn(instanceId: string): void { this.sent.delete(instanceId); }

  forget(instanceId: string): void { this.sent.delete(instanceId); }

  /**
   * What to do with a worker turn that completed cleanly: 'ok' to carry on to checking,
   * 'reminded' when a reminder turn was started, or the reason the turn counts as failed.
   */
  afterTurn(item: PlanQueueItem, instanceId: string): 'ok' | 'reminded' | { failed: string } {
    const live = this.host.instances.getInstance(instanceId);
    const provider = live?.provider ?? item.workerProvider ?? this.host.getRun(item.runId).workerProvider;
    if (item.workerReport || !provider || !requiredProviders.has(provider)) return 'ok';
    const count = this.sent.get(instanceId) ?? 0;
    if (count >= MAX_WORKER_REMINDERS || !live || AUTOMATION_FAILURE_STATUSES.has(live.status)) {
      return { failed: `the worker ended its turn without reporting its work ready, after ${count} reminder${count === 1 ? '' : 's'}` };
    }
    this.sent.set(instanceId, count + 1);
    this.host.tracker.beginTurn(instanceId);
    // Not awaited, like the first turn: some adapters settle sendInput only when the turn ends, and the caller
    // holds the item lock that Pause and Cancel need.
    const prompt = buildWorkerReminderPrompt(item.id, count + 1, MAX_WORKER_REMINDERS, WORKER_WAIT_RULE);
    logPromptInjection('queueWorkerReminder', prompt, instanceId);
    void this.host.instances.sendInput(instanceId, prompt, undefined, { automatedInput: true, internalSource: 'plan-queue' })
      .catch((error: unknown) => {
        if (this.host.tracker.isShuttingDown()) return;
        logger.warn('Plan queue: could not remind the worker', { itemId: item.id, instanceId, error: errorMessage(error) });
        this.onSendFailed(instanceId, { kind: 'failed', reason: `its reminder turn failed: ${errorMessage(error)}` });
      });
    return 'reminded';
  }
}
