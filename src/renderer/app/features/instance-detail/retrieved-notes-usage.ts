import type { OutputMessage } from '../../core/state/instance.store';
import { retrievedContextDeliveriesOf } from '../../../../shared/utils/input-context-delivery';
export function retrievedNotesUsage(messages: readonly OutputMessage[]): { times: number; tokens: number | null } {
  let times = 0; let tokens = 0; let unknown = false;
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.type !== 'user' || seen.has(message.id)) continue;
    seen.add(message.id);
    let added = 0; let injected = false;
    for (const key of ['rlmContext', 'unifiedMemoryContext', 'indexedCodebaseContext']) {
      const context = message.metadata?.[key] as { injected?: unknown; tokens?: unknown } | undefined;
      if (typeof context?.tokens === 'number' && Number.isFinite(context.tokens) && context.tokens > 0) {
        added += context.tokens; injected = true;
      } else if (context?.injected === true && !(typeof context.tokens === 'number' && context.tokens === 0)) {
        injected = true; unknown = true;
      }
    }
    for (const value of Object.values(retrievedContextDeliveriesOf(message.metadata))) {
      injected = true;
      if (value === null) unknown = true; else added += value;
    }
    if (injected) { times++; tokens += added; }
  }
  return { times, tokens: unknown ? null : tokens };
}
