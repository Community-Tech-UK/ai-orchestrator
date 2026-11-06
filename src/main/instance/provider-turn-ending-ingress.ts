import type { Instance } from '../../shared/types/instance.types';
import type { ProviderRuntimeEvent } from '@contracts/types/provider-runtime-events';
import { mapAdapterRuntimeEvent } from '../providers/adapter-runtime-event-bridge';
import { AdapterTurnEndingObservation } from '../providers/adapter-turn-ending-observation';

const observations = new WeakMap<Instance, { generation: number | undefined; observer: AdapterTurnEndingObservation }>();

/** Interactive adapters publish here; loop adapters arrive already normalized. */
export function enrichProviderTurnEndingIngress(instance: Instance | undefined, event: ProviderRuntimeEvent, payload?: unknown): ProviderRuntimeEvent {
  if (!instance) return event;
  let entry = observations.get(instance);
  if (!entry || entry.generation !== instance.adapterGeneration) {
    entry = { generation: instance.adapterGeneration, observer: new AdapterTurnEndingObservation(() => ({ adapter: instance.provider, model: instance.currentModel })) };
    observations.set(instance, entry);
  }
  if (event.kind !== 'complete' && event.kind !== 'error') {
    const mapped = payload && (event.kind === 'tool_use' || event.kind === 'tool_result') ? mapAdapterRuntimeEvent(event.kind, [payload]) : undefined;
    return entry.observer.enrich(mapped ? { ...event, ...mapped.event } as ProviderRuntimeEvent : event, payload);
  }
  // Existing normalized loop events have the authoritative original Error
  // object's evidence. Do not replace it with its redacted capture projection.
  let normalized: ProviderRuntimeEvent = event;
  if (!event.turnEnding) {
    const raw = payload ?? (event.kind === 'error' ? event.message : undefined);
    const mapped = raw !== undefined ? mapAdapterRuntimeEvent(event.kind, [raw]) : null;
    if (mapped) normalized = { ...mapped.event, ...event } as ProviderRuntimeEvent;
  }
  // Without a captured payload there is no completion text to observe. The
  // shape must not claim `content`, or a missing capture reads as an empty reply.
  const raw = payload ?? (event.kind === 'error' ? event.message : {
    metadata: { stopReason: event.stopReason, finish: event.finish },
    usage: { outputTokens: event.outputTokens, reasoningTokens: event.reasoningTokens },
  });
  return entry.observer.enrich(normalized, raw);
}
