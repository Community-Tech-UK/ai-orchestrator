import { getLogger } from '../logging/logger';
import { BoundedAsyncQueue } from '../runtime/bounded-async-queue';
import { getSessionContinuityManager } from '../session/session-continuity';
import type { ConversationEntry } from '../session/session-continuity.types';

const logger = getLogger('InstanceEventForwarding');

export type ContinuityTask =
  | { kind: 'state'; instanceId: string; update: Record<string, unknown> }
  | { kind: 'checkpoint'; instanceId: string; epoch: number }
  | { kind: 'entry'; instanceId: string; entry: ConversationEntry }
  | {
      kind: 'patch';
      instanceId: string;
      entryId: string;
      patch: Partial<Omit<ConversationEntry, 'id'>>;
      /** Added instead when the entry to patch was never stored (e.g. its add was dropped). */
      fallback?: ConversationEntry;
    };

/** Content ordering fences completion proofs; any dropped/failed task invalidates origin coverage. */
export function createContinuityForwardingQueue(maxSize = 2_000): BoundedAsyncQueue<ContinuityTask> {
  return new BoundedAsyncQueue<ContinuityTask>({
    name: 'session-continuity', maxSize, concurrency: 1,
    process: async (task) => {
      const continuity = getSessionContinuityManager();
      try {
        if (task.kind === 'checkpoint') {
          await continuity.checkpointCompleteConversation(task.instanceId, task.epoch);
        } else if (task.kind === 'state') {
          await continuity.updateState(task.instanceId, task.update as Parameters<typeof continuity.updateState>[1]);
        } else if (task.kind === 'entry') {
          if (await continuity.addConversationEntry(task.instanceId, task.entry) === false) continuity.markConversationIncomplete(task.instanceId);
        } else {
          const stored = task.fallback
            ? await continuity.patchConversationEntry(task.instanceId, task.entryId, task.patch, task.fallback)
            : await continuity.patchConversationEntry(task.instanceId, task.entryId, task.patch);
          if (stored === false) continuity.markConversationIncomplete(task.instanceId);
        }
      } catch (err) {
        continuity.markConversationIncomplete(task.instanceId);
        logger.warn('Continuity queue task failed', { kind: task.kind, instanceId: task.instanceId,
          error: err instanceof Error ? err.message : String(err) });
      }
    },
    onDrop: (task, reason) => {
      getSessionContinuityManager().markConversationIncomplete(task.instanceId);
      if (reason === 'capacity') logger.debug('Continuity queue dropped task (capacity)');
    },
  });
}
