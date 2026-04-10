import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { MemoryIpcService } from '../services/ipc/memory-ipc.service';
import type {
  KGQueryResult,
  KGStats,
} from '../../../../shared/types/knowledge-graph.types';
import type { WakeContext } from '../../../../shared/types/wake-context.types';

interface MiningStatus {
  mined: boolean;
  normalizedPath: string;
}

interface ImportEvent {
  sourceFile: string;
  segmentsCreated: number;
  format: string;
}

interface RecentFactEvent {
  tripleId: string;
  subject: string;
  predicate: string;
  object: string;
}

@Injectable({ providedIn: 'root' })
export class KnowledgeStore implements OnDestroy {
  private memoryIpc = inject(MemoryIpcService);
  private unsubscribes: (() => void)[] = [];
  private wakeWing: string | undefined;

  private _stats = signal<KGStats | null>(null);
  private _entityFacts = signal<KGQueryResult[]>([]);
  private _timeline = signal<KGQueryResult[]>([]);
  private _selectedEntity = signal('');
  private _recentFacts = signal<RecentFactEvent[]>([]);
  private _wakeContext = signal<WakeContext | null>(null);
  private _miningStatus = signal<MiningStatus | null>(null);
  private _importEvents = signal<ImportEvent[]>([]);
  private _loading = signal(false);
  private _error = signal<string | null>(null);

  readonly stats = this._stats.asReadonly();
  readonly entityFacts = this._entityFacts.asReadonly();
  readonly timeline = this._timeline.asReadonly();
  readonly selectedEntity = this._selectedEntity.asReadonly();
  readonly recentFacts = this._recentFacts.asReadonly();
  readonly wakeContext = this._wakeContext.asReadonly();
  readonly miningStatus = this._miningStatus.asReadonly();
  readonly importEvents = this._importEvents.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();

  readonly hasKnowledge = computed(() => {
    const stats = this._stats();
    return stats !== null && (stats.entities > 0 || stats.triples > 0);
  });

  readonly factCount = computed(() => this._stats()?.triples ?? 0);
  readonly entityCount = computed(() => this._stats()?.entities ?? 0);

  constructor() {
    this.subscribeToEvents();
  }

  ngOnDestroy(): void {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
  }

  async loadStats(): Promise<void> {
    const response = await this.memoryIpc.kgGetStats();
    if (response.success) {
      this._stats.set(response.data as KGStats);
      return;
    }
    this._error.set(response.error?.message ?? 'Failed to load knowledge stats');
  }

  async queryEntity(entityName: string): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    this._selectedEntity.set(entityName);

    try {
      const response = await this.memoryIpc.kgQueryEntity({ entityName });
      if (response.success) {
        this._entityFacts.set(response.data as KGQueryResult[]);
        return;
      }
      this._error.set(response.error?.message ?? 'Entity query failed');
    } finally {
      this._loading.set(false);
    }
  }

  async loadTimeline(entityName: string, limit = 50): Promise<void> {
    const response = await this.memoryIpc.kgGetTimeline({ entityName, limit });
    if (response.success) {
      this._timeline.set(response.data as KGQueryResult[]);
      return;
    }
    this._error.set(response.error?.message ?? 'Failed to load timeline');
  }

  async loadWakeContext(wing?: string): Promise<void> {
    this.wakeWing = wing;
    const response = await this.memoryIpc.wakeGenerate({ wing });
    if (response.success) {
      this._wakeContext.set(response.data as WakeContext);
      return;
    }
    this._error.set(response.error?.message ?? 'Failed to generate wake context');
  }

  async checkMiningStatus(dirPath: string): Promise<void> {
    const response = await this.memoryIpc.codebaseGetStatus({ dirPath });
    if (response.success) {
      this._miningStatus.set(response.data as MiningStatus);
      return;
    }
    this._error.set(response.error?.message ?? 'Failed to get mining status');
  }

  async triggerMining(dirPath: string): Promise<void> {
    this._loading.set(true);
    this._error.set(null);

    try {
      const response = await this.memoryIpc.codebaseMineDirectory({ dirPath });
      if (!response.success) {
        this._error.set(response.error?.message ?? 'Mining failed');
        return;
      }

      await Promise.all([
        this.loadStats(),
        this.checkMiningStatus(dirPath),
      ]);
    } finally {
      this._loading.set(false);
    }
  }

  clearError(): void {
    this._error.set(null);
  }

  private subscribeToEvents(): void {
    this.unsubscribes.push(
      this.memoryIpc.onKgFactAdded((data) => {
        const facts = this._recentFacts();
        this._recentFacts.set([data as RecentFactEvent, ...facts].slice(0, 50));
        void this.loadStats();
      }),
      this.memoryIpc.onKgFactInvalidated(() => {
        void this.loadStats();
      }),
      this.memoryIpc.onConvoImportComplete((data) => {
        const events = this._importEvents();
        this._importEvents.set([data as ImportEvent, ...events].slice(0, 20));
      }),
      this.memoryIpc.onWakeHintAdded(() => {
        void this.loadWakeContext(this.wakeWing);
      }),
      this.memoryIpc.onWakeContextGenerated((data) => {
        const current = this._wakeContext();
        if (!current) {
          return;
        }

        const event = data as { totalTokens: number; wing?: string };
        if (event.wing !== undefined && event.wing !== current.wing) {
          return;
        }

        this._wakeContext.set({
          ...current,
          totalTokens: event.totalTokens,
          wing: event.wing ?? current.wing,
        });
      }),
    );
  }
}
