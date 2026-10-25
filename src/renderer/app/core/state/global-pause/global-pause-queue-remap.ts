import type { GlobalPauseEntry } from '@contracts/schemas/global-pause';
import type { QueuedMessage } from '../instance/instance.types';

/** Preserve message objects (and their durable-row association) when revival assigns a new session id. */
export function remapPauseQueues(entries: GlobalPauseEntry[], current: Map<string, QueuedMessage[]>): Map<string, QueuedMessage[]> | null {
  let next: Map<string, QueuedMessage[]> | null = null;
  for (const entry of entries) {
    const oldId = entry.originalInstanceId;
    if (entry.kind !== 'session' || !oldId || oldId === entry.targetId) continue;
    const source = next ?? current;
    const queue = source.get(oldId);
    if (!queue?.length) continue;
    next ??= new Map(current);
    next.set(entry.targetId, [...(source.get(entry.targetId) ?? []), ...queue]);
    next.delete(oldId);
  }
  return next;
}
