import { randomUUID } from 'node:crypto';
import { IPC_CHANNELS } from '@contracts/channels';
import { encodeJsonChunks } from '../../shared/utils/json-chunks';
import { parseInstanceTranscriptReplay } from '../../shared/utils/instance-transcript-replay';
import type { Instance } from '../../shared/types/instance.types';
import type { BoundedAsyncQueue } from '../runtime/bounded-async-queue';
import type { ContinuityTask } from './continuity-forwarding-queue';
import { outputMessagesToContinuityEntries } from '../session/continuity-message-projection';
import { registerCleanup } from '../util/cleanup-registry';
import { getLogger } from '../logging/logger';

interface ReplaySource {
  on(event: string, listener: (payload: unknown) => void): unknown;
  removeListener(event: string, listener: (payload: unknown) => void): unknown;
  getInstance(instanceId: string): Instance | undefined;
}
/** Repaired history bypasses ordinary output hooks; persist once and publish one bounded snapshot. */
export function setupInstanceTranscriptReplayForwarding(options: {
  instanceManager: ReplaySource;
  windowManager: { sendToRenderer(channel: string, payload: unknown): void };
  continuityQueue: Pick<BoundedAsyncQueue<ContinuityTask>, 'enqueue'>;
}): () => void {
  const { instanceManager, windowManager, continuityQueue } = options;
  const revisions = new Map<string, number>();
  const logger = getLogger('InstanceTranscriptReplay');
  const replay = (input: unknown): void => {
    const payload = input as { instanceId?: unknown; adapterGeneration?: unknown; restartEpoch?: unknown; messages?: unknown } | null;
    if (!payload || typeof payload.instanceId !== 'string') return;
    const instance = instanceManager.getInstance(payload.instanceId);
    if (!instance || payload.adapterGeneration !== (instance.adapterGeneration ?? 0)
      || payload.restartEpoch !== instance.restartEpoch) return;
    const revision = (revisions.get(instance.id) ?? 0) + 1;
    revisions.set(instance.id, revision);
    const identity = { kind: 'history-replay' as const, instanceId: instance.id, createdAt: instance.createdAt,
      adapterGeneration: instance.adapterGeneration ?? 0, restartEpoch: instance.restartEpoch, revision };
    try {
      const snapshot = parseInstanceTranscriptReplay({ ...identity, messages: payload.messages });
      continuityQueue.enqueue({ kind: 'state', instanceId: instance.id, update: {
        conversationHistory: outputMessagesToContinuityEntries(snapshot.messages),
        conversationHistoryComplete: false, conversationHistoryOriginKnown: false,
      } });
      const chunks = encodeJsonChunks(snapshot, randomUUID());
      for (const chunk of chunks) windowManager.sendToRenderer(IPC_CHANNELS.INSTANCE_TRANSCRIPT_CHUNK, { ...identity, chunk });
    } catch {
      logger.warn('Unable to publish a bounded native history snapshot', { instanceId: instance.id });
      windowManager.sendToRenderer(IPC_CHANNELS.INSTANCE_TRANSCRIPT_CHUNK, { ...identity, kind: 'history-replay-error' });
    }
  };
  const removed = (instanceId: unknown): void => { if (typeof instanceId === 'string') revisions.delete(instanceId); };
  instanceManager.on('history-replayed', replay);
  instanceManager.on('instance:removed', removed);
  const cleanup = (): void => {
    instanceManager.removeListener('history-replayed', replay);
    instanceManager.removeListener('instance:removed', removed);
    revisions.clear(); unregister();
  };
  const unregister = registerCleanup(cleanup);
  return cleanup;
}
