import { Injectable, computed, inject, signal } from '@angular/core';
import { CommandIpcService } from '../services/ipc';

export type UsageKind = 'command' | 'session' | 'model' | 'prompt' | 'resume';

export interface UsageEntry {
  kind: UsageKind;
  id: string;
  count: number;
  lastUsedAt: number;
  contexts: Record<string, number>;
}

export type UsageSnapshot = Record<string, UsageEntry>;

function usageKey(kind: UsageKind, id: string): string {
  return `${kind}:${id}`;
}

@Injectable({ providedIn: 'root' })
export class UsageStore {
  private commandIpc = inject(CommandIpcService);
  private _entries = signal<UsageSnapshot>({});

  readonly entries = this._entries.asReadonly();
  readonly initialized = signal(false);

  readonly commandEntries = computed(() =>
    Object.values(this._entries()).filter((entry) => entry.kind === 'command'),
  );

  async init(): Promise<void> {
    const response = await this.commandIpc.getUsageSnapshot();
    if (response.success && response.data && typeof response.data === 'object') {
      this._entries.set(response.data as UsageSnapshot);
    }
    this.initialized.set(true);
  }

  frecency(kind: UsageKind, id: string, now = Date.now()): number {
    const entry = this._entries()[usageKey(kind, id)];
    if (!entry) return 0;
    const ageHours = Math.max(0, (now - entry.lastUsedAt) / 3_600_000);
    const recency = 1 / (1 + ageHours / 24);
    return entry.count * recency;
  }

  async record(kind: UsageKind, id: string, context?: string): Promise<void> {
    const timestamp = Date.now();
    const key = usageKey(kind, id);
    this._entries.update((entries) => {
      const previous = entries[key];
      const contexts = { ...(previous?.contexts ?? {}) };
      if (context) contexts[context] = (contexts[context] ?? 0) + 1;
      return {
        ...entries,
        [key]: {
          kind,
          id,
          count: (previous?.count ?? 0) + 1,
          lastUsedAt: timestamp,
          contexts,
        },
      };
    });

    const response = await this.commandIpc.recordUsage(kind, id, context);
    if (response.success && response.data) {
      this._entries.update((entries) => ({
        ...entries,
        [key]: response.data as UsageEntry,
      }));
    }
  }
}
