import ElectronStore from 'electron-store';

interface PersistedQueueEntry {
  message: string;
  hadAttachmentsDropped: boolean;
  retryCount?: number;
  seededAlready?: boolean;
  kind?: 'queue' | 'steer';
}

interface QueueStoreShape {
  queues?: Record<string, PersistedQueueEntry[]>;
}

interface Store<T> {
  store: T;
  set<K extends keyof T>(key: K, value: T[K]): void;
  clear(): void;
}

let queueStore: Store<QueueStoreShape> | null = null;

function getQueueStore(): Store<QueueStoreShape> {
  queueStore ??= new ElectronStore<QueueStoreShape>({
    name: 'instance-message-queue',
  }) as unknown as Store<QueueStoreShape>;
  return queueStore;
}

export function clearInstanceQueueStore(): void {
  getQueueStore().clear();
}

export function saveInstanceQueue(
  instanceId: string,
  queue: PersistedQueueEntry[],
): void {
  const store = getQueueStore();
  const queues = { ...(store.store.queues ?? {}) };
  if (queue.length === 0) {
    delete queues[instanceId];
  } else {
    queues[instanceId] = queue.map((entry) => ({
      message: entry.message,
      hadAttachmentsDropped: entry.hadAttachmentsDropped,
      retryCount: entry.retryCount,
      seededAlready: entry.seededAlready,
      kind: entry.kind,
    }));
  }
  store.set('queues', queues);
}

export function loadAllInstanceQueues(): Record<string, PersistedQueueEntry[]> {
  return getQueueStore().store.queues ?? {};
}
