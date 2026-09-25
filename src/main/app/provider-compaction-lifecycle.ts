import type { OutputMessage } from '../../shared/types/instance.types';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { getLogger } from '../logging/logger';
import { recordLifecycleTrace } from '../observability/lifecycle-trace';

const logger = getLogger('InstanceEventForwarding');

export function buildProviderCompactionStatusEvent(
  instanceId: string,
  message: OutputMessage,
  status: 'started' | 'completed',
): Record<string, unknown> {
  if (status === 'started') return { instanceId, status };
  const outcome = message.metadata?.['providerCompactionOutcome'];
  const success = outcome === undefined || outcome === 'settled';
  return {
    instanceId, status, success, method: 'native', blocking: false,
    ...(!success ? { error: message.content } : {}),
  };
}

export class ProviderCompactionLifecycleRecorder {
  private readonly startedAt = new Map<string, number>();

  forget(instanceId: string): void {
    this.startedAt.delete(instanceId);
  }

  record(
    envelope: ProviderRuntimeEventEnvelope,
    message: OutputMessage,
    phase: 'started' | 'completed',
  ): void {
    const at = message.timestamp || Date.now();
    if (phase === 'started') this.startedAt.set(envelope.instanceId, at);
    const start = this.startedAt.get(envelope.instanceId);
    const durationMs = phase === 'completed' && start !== undefined ? Math.max(0, at - start) : undefined;
    const turnId = typeof message.metadata?.['providerCompactionTurnId'] === 'string'
      ? message.metadata['providerCompactionTurnId'] : undefined;
    const trigger = message.metadata?.['providerCompactionTrigger'] === 'policy' ? 'policy' : 'self-managed';
    const outcome = typeof message.metadata?.['providerCompactionOutcome'] === 'string'
      ? message.metadata['providerCompactionOutcome'] : undefined;
    const terminalStatus = phase === 'completed' && outcome && outcome !== 'settled' ? outcome : phase;
    const details = {
      instanceId: envelope.instanceId, threadId: envelope.sessionId, turnId, durationMs, trigger, outcome,
    };
    if (terminalStatus === phase) logger.info(`Codex compaction ${phase}`, details);
    else logger.warn(`Codex compaction ${terminalStatus}`, details);
    recordLifecycleTrace({
      instanceId: envelope.instanceId,
      provider: envelope.provider,
      turnId,
      eventType: 'provider-compaction',
      status: terminalStatus,
      timestamp: at,
      metadata: { phase, outcome, threadId: envelope.sessionId, durationMs, trigger },
    });
    if (phase === 'completed') this.startedAt.delete(envelope.instanceId);
  }
}
