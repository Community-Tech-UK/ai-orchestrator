import type { ProviderId } from '../../shared/types/provider-quota.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('ProviderLimitResumeScheduler');

export interface ProviderLimitResumeRequest {
  loopRunId: string;
  chatId: string;
  workspaceCwd: string;
  provider: ProviderId;
  resumeAt: number;
  reason: string;
  source: 'quota' | 'notice';
  action: string;
  windowId?: string;
}

export function scheduleProviderLimitResume(params: {
  request: ProviderLimitResumeRequest;
  resumeLoop: (loopRunId: string) => boolean;
}): () => void {
  const { request, resumeLoop } = params;
  let automationId: string | null = null;
  let cancelled = false;

  void (async () => {
    const { createAutomationWithScheduling } = await import('../automations/automation-create-service');
    const automation = await createAutomationWithScheduling({
      name: `Resume loop after ${request.provider} quota reset`,
      description: `Auto-created provider-limit wake for loop ${request.loopRunId}.`,
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
        instanceId: request.chatId,
        reviveIfArchived: true,
      },
      action: {
        workingDirectory: request.workspaceCwd,
        provider: request.provider,
        systemAction: {
          type: 'loopProviderLimitResume',
          loopRunId: request.loopRunId,
        },
        prompt: [
          `Provider quota window reset for loop ${request.loopRunId}.`,
          `Reason: ${request.reason}`,
          'Harness will try to resume the paused loop directly. If direct resume is unavailable, report the loop status and next action.',
        ].join('\n'),
      },
    });
    automationId = automation?.id ?? null;
    if (cancelled && automationId) {
      const { getAutomationStore } = await import('../automations');
      await getAutomationStore().delete(automationId);
    }
  })().catch((err) => {
    logger.warn('Failed to create durable provider-limit resume automation', {
      loopRunId: request.loopRunId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const delay = Math.max(0, request.resumeAt - Date.now()) + 5_000;
  const timer = setTimeout(() => {
    const resumed = resumeLoop(request.loopRunId);
    logger.info('Provider-limit local resume timer fired', {
      loopRunId: request.loopRunId,
      resumed,
    });
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();

  return () => {
    cancelled = true;
    clearTimeout(timer);
    if (!automationId) return;
    void import('../automations')
      .then(({ getAutomationStore }) => getAutomationStore().delete(automationId as string))
      .catch((err) => logger.warn('Failed to delete provider-limit resume automation', {
        loopRunId: request.loopRunId,
        automationId,
        error: err instanceof Error ? err.message : String(err),
      }));
  };
}
