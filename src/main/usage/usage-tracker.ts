import ElectronStore from 'electron-store';

export type UsageKind = 'command' | 'session' | 'model' | 'prompt' | 'resume';

export interface UsageEntry {
  kind: UsageKind;
  id: string;
  count: number;
  lastUsedAt: number;
  contexts: Record<string, number>;
}

export type UsageSnapshot = Record<string, UsageEntry>;

interface UsageTrackerSchema {
  entries: UsageSnapshot;
}

interface Store<T> {
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
}

const store = new ElectronStore<UsageTrackerSchema>({
  name: 'usage-tracker',
  defaults: { entries: {} },
}) as unknown as Store<UsageTrackerSchema>;

let instance: UsageTracker | null = null;

function keyFor(kind: UsageKind, id: string): string {
  return `${kind}:${id}`;
}

export class UsageTracker {
  static getInstance(): UsageTracker {
    if (!instance) {
      instance = new UsageTracker();
    }
    return instance;
  }

  static _resetForTesting(): void {
    instance = null;
    store.set('entries', {});
  }

  record(kind: UsageKind, id: string, context?: string, timestamp = Date.now()): UsageEntry {
    const entries = { ...store.get('entries') };
    const key = keyFor(kind, id);
    const previous = entries[key];
    const contexts = { ...(previous?.contexts ?? {}) };
    if (context) {
      contexts[context] = (contexts[context] ?? 0) + 1;
    }

    const next: UsageEntry = {
      kind,
      id,
      count: (previous?.count ?? 0) + 1,
      lastUsedAt: timestamp,
      contexts,
    };
    entries[key] = next;
    store.set('entries', entries);
    return next;
  }

  snapshot(kind?: UsageKind): UsageSnapshot {
    const entries = store.get('entries');
    if (!kind) {
      return { ...entries };
    }

    const filtered: UsageSnapshot = {};
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.kind === kind) {
        filtered[key] = { ...entry, contexts: { ...entry.contexts } };
      }
    }
    return filtered;
  }

  frecency(kind: UsageKind, id: string, now = Date.now()): number {
    const entry = store.get('entries')[keyFor(kind, id)];
    if (!entry) return 0;
    const ageHours = Math.max(0, (now - entry.lastUsedAt) / 3_600_000);
    const recency = 1 / (1 + ageHours / 24);
    return entry.count * recency;
  }
}

export function getUsageTracker(): UsageTracker {
  return UsageTracker.getInstance();
}
