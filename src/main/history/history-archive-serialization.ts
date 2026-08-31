import type { Instance } from '../../shared/types/instance.types';

type ArchiveSerializationIdentity = Pick<
  Instance,
  'id' | 'provider' | 'historyThreadId' | 'providerSessionId' | 'sessionId'
>;

/**
 * Match the key used by history upserts whenever possible. Legacy instances
 * without an app-owned history thread fall back narrowly to their provider
 * session, then their runtime id, so unrelated sessions never share a queue.
 */
export function getArchiveSerializationKey(instance: ArchiveSerializationIdentity): string {
  const historyThreadId = instance.historyThreadId?.trim();
  if (historyThreadId) {
    return `history:${historyThreadId}`;
  }

  const sessionId = instance.providerSessionId?.trim() || instance.sessionId?.trim();
  if (sessionId) {
    return `session:${instance.provider}:${sessionId}`;
  }

  return `instance:${instance.provider}:${instance.id}`;
}

export class KeyedSerialTaskQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const predecessor = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => turn);
    this.tails.set(key, tail);

    await predecessor;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
