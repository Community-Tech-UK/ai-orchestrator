import type { CliAdapter } from '../cli/adapters/adapter-factory';
import {
  observeAdapterRuntimeEvents,
  type AdapterRuntimeEventSource,
} from '../providers/adapter-runtime-event-bridge';
import { toJsonSafeProviderEventPayload } from '../providers/provider-event-raw-payload';
import type {
  ProviderName,
  ProviderRuntimeEvent,
  ProviderRuntimeEventRaw,
} from '@contracts/types/provider-runtime-events';

export interface LoopRuntimeEventPublisher {
  emitProviderRuntimeEvent?: (
    instanceId: string,
    event: ProviderRuntimeEvent,
    options: {
      provider: ProviderName;
      timestamp?: number;
      raw: ProviderRuntimeEventRaw;
    },
  ) => void;
}

export interface ObserveLoopProviderRuntimeEventsInput {
  adapter: CliAdapter;
  instanceManager: LoopRuntimeEventPublisher;
  instanceId: string;
  provider: ProviderName;
}

/**
 * Loop adapters are owned directly by the loop invoker rather than
 * InstanceCommunicationManager. Mirror their normalized runtime events into
 * InstanceManager's canonical event bus so the same durable raw capture path
 * covers both interactive and loop-owned turns.
 */
export function observeLoopProviderRuntimeEvents(
  input: ObserveLoopProviderRuntimeEventsInput,
): () => void {
  const publish = input.instanceManager.emitProviderRuntimeEvent;
  // Lightweight coordinator fixtures and compatibility embedders may expose
  // only the loop-invocation API. Production InstanceManager always supplies
  // the canonical ingress; absence must never break a running loop turn.
  if (typeof publish !== 'function') return () => { /* no canonical host */ };
  return observeAdapterRuntimeEvents(
    input.adapter as unknown as AdapterRuntimeEventSource,
    ({ event, rawPayload, timestamp }) => {
      publish.call(input.instanceManager, input.instanceId, event, {
        provider: input.provider,
        ...(timestamp !== undefined ? { timestamp } : {}),
        raw: {
          source: `adapter-event:${event.kind}`,
          payload: toJsonSafeProviderEventPayload(rawPayload),
        },
      });
    },
  );
}
