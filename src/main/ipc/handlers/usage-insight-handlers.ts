import { z } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
import { registerValidatedIpcHandler, type EnsureTrustedSender } from '../validated-handler';
import type { InstanceManager } from '../../instance/instance-manager';
import type { UsageInsightResponse } from '../../../shared/usage-insight/usage-insight.types';
import { getUsageInsightService } from '../../usage-insight/usage-insight-runtime';
import type { UsageInsightService } from '../../usage-insight/usage-insight-service';

const UsageInsightPayloadSchema = z.object({
  instanceId: z.string().min(1).max(100).optional(),
  refresh: z.boolean().optional(),
}).strict().optional().default({});

export interface UsageInsightHandlerDeps {
  instanceManager?: Pick<InstanceManager, 'getInstance'>;
  /** Replaces the app-wide service (tests). */
  service?: UsageInsightService;
  ensureTrustedSender?: EnsureTrustedSender;
}

/**
 * "Where your usage went". Answers straight away: `scanning` while the first read
 * of the transcripts is under way, `ready` once there is a report. See
 * `UsageInsightService`.
 */
export function registerUsageInsightHandlers(deps: UsageInsightHandlerDeps = {}): void {
  const service = deps.service ?? getUsageInsightService((instanceId) => {
    const instance = deps.instanceManager?.getInstance(instanceId);
    return instance
      ? { provider: instance.provider, sessionId: instance.sessionId, remote: instance.executionLocation?.type === 'remote' }
      : undefined;
  });
  registerValidatedIpcHandler<z.infer<typeof UsageInsightPayloadSchema>, UsageInsightResponse>(
    IPC_CHANNELS.USAGE_INSIGHT_GET,
    UsageInsightPayloadSchema,
    async (payload) => ({ success: true, data: service.getResponse(payload) }),
    { ensureTrustedSender: deps.ensureTrustedSender },
  );
}
