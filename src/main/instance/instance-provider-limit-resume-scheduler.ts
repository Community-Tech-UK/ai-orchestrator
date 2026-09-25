import type { InstanceProvider } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import { formatInternalInputForProvider } from './internal-input-provenance';

const logger = getLogger('InstanceProviderLimitResumeScheduler');

/**
 * A request to durably resume a *regular* (non-loop) interactive instance once
 * a provider quota / rate-limit window resets. Mirrors the loop coordinator's
 * {@link ../orchestration/provider-limit-resume-scheduler.ProviderLimitResumeRequest},
 * but the resume action re-sends the throttled user turn to the instance
 * instead of resuming a loop run.
 */
export interface InstanceProviderLimitResumeRequest {
  instanceId: string;
  workspaceCwd: string;
  provider: InstanceProvider;
  resumeAt: number;
  reason: string;
  /** The turn to re-send when the window resets (provider text; see LT-657); null when unknown. */
  resumePrompt: string | null;
  /**
   * Stable app-level thread identity, captured at park time. Carried into the
   * durable automation's `thread` destination so a fire that finds the
   * original instance gone can still recognize an already-live sibling
   * instance for the same underlying session (see
   * SessionRevivalService.findLiveInstance) instead of reviving a duplicate.
   */
  historyThreadId?: string;
  sessionId?: string;
}

/**
 * The turn to send when a park resumes and no user turn was captured to
 * re-send.
 *
 * `resumePrompt` is only populated by turns that went through
 * `InstanceCommunicationManager.sendInput`. A session created from a
 * create-time initial prompt dispatches straight to the adapter, so a park
 * raised on *that* turn's completion — the normal Claude shape, where the limit
 * notice arrives as exit-0 assistant content — records no prompt at all. Before
 * this existed such a park resumed by clearing itself and sending nothing, and
 * the session sat idle until someone noticed.
 *
 * Re-sending the initial prompt is not a safe substitute: by the time a
 * five-hour window closes the session can be hours into that task, and
 * replaying it restarts the work from the beginning. A continuation turn keeps
 * the transcript and the progress.
 *
 * Shared by the durable automation's dispatch fallback and
 * `InstanceProviderLimitHandler.resumeNow` so both halves of the feature resume
 * a promptless park identically.
 */
export function buildProviderLimitContinuationPrompt(): string {
  return [
    'The provider usage limit that stopped your previous turn has reset, so this session can continue.',
    '',
    'Pick the task back up from where that turn stopped. The conversation above is the record of what is already done: keep those results and do not repeat completed steps. If the task was already finished, say so in one line instead of redoing it.',
  ].join('\n');
}

/**
 * The continuation turn as it is actually sent. Harness wrote it, so it carries
 * the internal-input envelope and is re-sent as Harness input, never as a user
 * message (LT-657).
 */
export function buildProviderLimitContinuationTurn(): string {
  return formatInternalInputForProvider('provider-limit-resume', buildProviderLimitContinuationPrompt());
}

/**
 * Schedule an instance resume two ways, exactly like the loop path:
 *
 * 1. A **durable one-time automation** (survives app restart/crash) whose
 *    `systemAction` is `instanceProviderLimitResume`. The automation runner
 *    routes it back through the same handler when it fires.
 * 2. An **in-process timer** fallback for the common case where the app stays
 *    up across the window.
 *
 * Both eventually call `resumeInstance`, which is idempotent (the handler
 * de-dupes a double-fire), so wiring both is safe. Returns a canceller that
 * clears the timer and deletes the durable automation.
 */
export function scheduleInstanceProviderLimitResume(params: {
  request: InstanceProviderLimitResumeRequest;
  resumeInstance: (instanceId: string, opts?: { resumePromptFallback?: string }) => void;
}): () => void {
  const { request, resumeInstance } = params;
  let automationId: string | null = null;
  let cancelled = false;

  void (async () => {
    const { createAutomationWithScheduling } = await import('../automations/automation-create-service');
    const automation = await createAutomationWithScheduling({
      name: `Resume session after ${request.provider} quota reset`,
      // The reason belongs here, not in the dispatched prompt: it is triage
      // detail for whoever finds this row still pending, and reads as noise to
      // the model that receives the continuation turn.
      description: `Auto-created provider-limit resume for instance ${request.instanceId}. Reason: ${request.reason}`,
      enabled: true,
      schedule: {
        type: 'oneTime',
        runAt: request.resumeAt + 5_000,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      },
      missedRunPolicy: 'runOnce',
      concurrencyPolicy: 'skip',
      destination: {
        kind: 'thread',
        instanceId: request.instanceId,
        // Generic identity for SessionRevivalService.findLiveInstance/entryMatches
        // (matched by value against instance.historyThreadId/sessionId), not
        // literally a persisted history-entry id. Lets a fire that finds the
        // original instance gone still detect an already-live sibling for the
        // same underlying session before reviving a duplicate.
        ...(request.historyThreadId ? { historyEntryId: request.historyThreadId } : {}),
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        reviveIfArchived: true,
      },
      action: {
        workingDirectory: request.workspaceCwd,
        provider: request.provider,
        systemAction: {
          type: 'instanceProviderLimitResume',
          instanceId: request.instanceId,
          ...(request.resumePrompt ? { resumePrompt: request.resumePrompt } : {}),
        },
        // Dispatch fallback: used only when the systemAction handler decides it
        // cannot resume the live instance directly (e.g. after an app restart,
        // when the thread must be revived first). The runner then revives the
        // thread and sends this prompt. Prefer the paused turn so the
        // work actually continues; otherwise the shared continuation turn.
        prompt: request.resumePrompt
          ? request.resumePrompt
          : buildProviderLimitContinuationTurn(),
      },
    });
    automationId = automation?.id ?? null;
    if (cancelled && automationId) {
      const { getAutomationStore } = await import('../automations');
      await getAutomationStore().delete(automationId);
    }
  })().catch((err) => {
    logger.warn('Failed to create durable instance provider-limit resume automation', {
      instanceId: request.instanceId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const delay = Math.max(0, request.resumeAt - Date.now()) + 5_000;
  const timer = setTimeout(() => {
    resumeInstance(
      request.instanceId,
      request.resumePrompt ? { resumePromptFallback: request.resumePrompt } : undefined,
    );
    logger.info('Instance provider-limit local resume timer fired', { instanceId: request.instanceId });
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();

  return () => {
    cancelled = true;
    clearTimeout(timer);
    if (!automationId) return;
    void import('../automations')
      .then(({ getAutomationStore }) => getAutomationStore().delete(automationId as string))
      .catch((err) => logger.warn('Failed to delete instance provider-limit resume automation', {
        instanceId: request.instanceId,
        automationId,
        error: err instanceof Error ? err.message : String(err),
      }));
  };
}
