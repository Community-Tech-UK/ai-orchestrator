import type { InstanceProvider } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';

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
  /** The user turn to re-send when the window resets; null when unknown. */
  resumePrompt: string | null;
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
      description: `Auto-created provider-limit resume for instance ${request.instanceId}.`,
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
        // thread and sends this prompt. Prefer the user's paused turn so the
        // work actually continues; otherwise a short resume note.
        prompt: request.resumePrompt
          ? request.resumePrompt
          : [
              `Provider quota window reset for session ${request.instanceId}.`,
              `Reason: ${request.reason}`,
              'Continue the previous task.',
            ].join('\n'),
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
