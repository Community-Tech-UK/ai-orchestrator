import type { OutputMessage } from '../types/instance.types';
import type { InputContextDelivery, RetrievedContextDeliveries, RetrievedContextMetadata } from '../types/input-context-delivery.types';

export function retrievedContextDeliveriesOf(metadata: Record<string, unknown> | undefined): RetrievedContextDeliveries {
  const raw = metadata?.['retrievedContextDeliveries'];
  const result: RetrievedContextDeliveries = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [id, tokens] of Object.entries(raw)) {
    if (tokens === null || (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0)) result[id] = tokens;
  }
  return result;
}

/** Persist only retrieval measurements, never the retrieved content itself. */
export function retrievedContextMetadataOf(metadata: Record<string, unknown> | undefined): RetrievedContextMetadata {
  const result: RetrievedContextMetadata = {};
  for (const key of ['rlmContext', 'unifiedMemoryContext', 'indexedCodebaseContext'] as const) {
    const raw = metadata?.[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const context = raw as { injected?: unknown; tokens?: unknown };
    if (typeof context.tokens === 'number' && Number.isFinite(context.tokens) && context.tokens >= 0) {
      result[key] = { injected: true, tokens: context.tokens };
    } else if (context.injected === true) result[key] = { injected: true, tokens: null };
  }
  return result;
}

/** Updates existing user records only; never restores a trimmed prompt or emits output. */
export function applyInputContextDelivery(messages: readonly OutputMessage[], delivery: InputContextDelivery): OutputMessage[] {
  return messages.map(message => {
    if (message.id !== delivery.messageId || message.type !== 'user') return message;
    const previous = retrievedContextDeliveriesOf(message.metadata);
    if (Object.hasOwn(previous, delivery.deliveryId)) return message;
    return { ...message, metadata: { ...message.metadata,
      retrievedContextDeliveries: { ...previous, [delivery.deliveryId]: delivery.tokens } } };
  });
}
