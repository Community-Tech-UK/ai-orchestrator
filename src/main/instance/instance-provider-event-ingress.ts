import type { Instance } from '../../shared/types/instance.types';
import type {
  ProviderName,
  ProviderRuntimeEvent,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';
import type { PendingEnvelope } from '../providers/provider-runtime-event-bus';
import { resolveProviderName, resolveRuntimeEventTurnId } from './provider-runtime-helpers';

export interface ProviderRuntimeEventIngressOptions {
  provider?: ProviderName;
  sessionId?: string;
  timestamp?: number;
  raw?: ProviderRuntimeEventEnvelope['raw'];
}

interface BuildProviderRuntimeEventIngressInput {
  getInstance: (instanceId: string) => Instance | undefined;
  instanceId: string;
  event: ProviderRuntimeEvent;
  options?: ProviderRuntimeEventIngressOptions;
}

/** Build one canonical or capture-only event from the current instance state. */
export function buildProviderRuntimeEventIngress(
  input: BuildProviderRuntimeEventIngressInput,
): PendingEnvelope | null {
  const instance = input.getInstance(input.instanceId);
  const provider = resolveProviderName(input.instanceId, input.options?.provider, instance?.provider);
  if (!provider) return null;

  return {
    timestamp: input.options?.timestamp ?? Date.now(),
    provider,
    instanceId: input.instanceId,
    sessionId: input.options?.sessionId ?? instance?.providerSessionId ?? instance?.sessionId,
    adapterGeneration: instance?.adapterGeneration,
    turnId: resolveRuntimeEventTurnId(input.event, instance),
    raw: input.options?.raw,
    event: input.event,
  };
}
