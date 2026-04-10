import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { MemoryIpcService } from '../services/ipc/memory-ipc.service';
import type {
  KGQueryResult,
  KGStats,
} from '../../../../shared/types/knowledge-graph.types';
import type { WakeContext, WakeHint } from '../../../../shared/types/wake-context.types';

interface MiningStatus {
  mined: boolean;
  normalizedPath: string;
}

interface ImportEvent {
  sourceFile: string;
  segmentsCreated: number;
  format: string;
}

interface ConvoImportResult {
  segmentsCreated: number;
  filesProcessed: number;
  formatDetected: string;
  errors: string[];
  duration: number;
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
  private _wakeHints = signal<WakeHint[]>([]);
  private _wakeIdentity = signal('');
  private _relationshipResults = signal<KGQueryResult[]>([]);
  private _selectedPredicate = signal('');
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
  readonly wakeHints = this._wakeHints.asReadonly();
  readonly wakeIdentity = this._wakeIdentity.asReadonly();
  readonly relationshipResults = this._relationshipResults.asReadonly();
  readonly selectedPredicate = this._selectedPredicate.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();

  readonly hasKnowledge = computed(() => {
    const stats = this._stats();
    return stats !== null && (stats.entities > 0 || stats.triples > 0);
  });

  readonly factCount = computed(() => this._stats()?.triples ?? 0);
  readonly entityCount = computed(() => this._stats()?.entities ?? 0);
  readonly hintCount = computed(() => this._wakeHints().length);

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

  // --- Write Actions ---

  async addFact(payload: {
    subject: string;
    predicate: string;
    object: string;
    confidence?: number;
    validFrom?: string;
    sourceFile?: string;
  }): Promise<boolean> {
    const response = await this.memoryIpc.kgAddFact(payload);
    if (response.success) {
      await this.loadStats();
      const entity = this._selectedEntity();
      if (entity && (payload.subject === entity || payload.object === entity)) {
        await this.queryEntity(entity);
      }
      return true;
    }
    this._error.set(response.error?.message ?? 'Failed to add fact');
    return false;
  }

  async invalidateFact(payload: {
    subject: string;
    predicate: string;
    object: string;
  }): Promise<boolean> {
    const response = await this.memoryIpc.kgInvalidateFact(payload);
    if (response.success) {
      await this.loadStats();
      const entity = this._selectedEntity();
      if (entity) {
        await Promise.all([
          this.queryEntity(entity),
          this.loadTimeline(entity),
        ]);
      }
      return true;
    }
    this._error.set(response.error?.message ?? 'Failed to invalidate fact');
    return false;
  }

  async queryRelationship(predicate: string, asOf?: string): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    this._selectedPredicate.set(predicate);
    try {
      const response = await this.memoryIpc.kgQueryRelationship({ predicate, asOf });
      if (response.success) {
        this._relationshipResults.set(response.data as KGQueryResult[]);
      } else {
        this._error.set(response.error?.message ?? 'Relationship query failed');
      }
    } finally {
      this._loading.set(false);
    }
  }

  // --- Wake Write Actions ---

  async listHints(room?: string): Promise<void> {
    const response = await this.memoryIpc.wakeListHints({ room });
    if (response.success) {
      this._wakeHints.set(response.data as WakeHint[]);
    } else {
      this._error.set(response.error?.message ?? 'Failed to list hints');
    }
  }

  async addHint(content: string, importance?: number, room?: string): Promise<boolean> {
    const response = await this.memoryIpc.wakeAddHint({ content, importance, room });
    if (response.success) {
      await this.listHints();
      return true;
    }
    this._error.set(response.error?.message ?? 'Failed to add hint');
    return false;
  }

  async removeHint(id: string): Promise<boolean> {
    const response = await this.memoryIpc.wakeRemoveHint({ id });
    if (response.success) {
      await this.listHints();
      return true;
    }
    this._error.set(response.error?.message ?? 'Failed to remove hint');
    return false;
  }

  async setIdentity(text: string): Promise<boolean> {
    const response = await this.memoryIpc.wakeSetIdentity({ text });
    if (response.success) {
      this._wakeIdentity.set(text);
      await this.loadWakeContext(this.wakeWing);
      return true;
    }
    this._error.set(response.error?.message ?? 'Failed to set identity');
    return false;
  }

  async loadIdentity(): Promise<void> {
    const response = await this.memoryIpc.wakeGenerate({});
    if (response.success) {
      const data = response.data as WakeContext;
      this._wakeIdentity.set(data.identity.content);
    }
  }

  // --- Conversation Import Actions ---

  async importConversationString(content: string, wing: string, sourceFile: string, format?: string): Promise<ConvoImportResult | null> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await this.memoryIpc.convoImportString({ content, wing, sourceFile, format });
      if (response.success) {
        await this.loadStats();
        return response.data as ConvoImportResult;
      }
      this._error.set(response.error?.message ?? 'Import failed');
      return null;
    } finally {
      this._loading.set(false);
    }
  }

  async importConversationFile(filePath: string, wing: string): Promise<ConvoImportResult | null> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await this.memoryIpc.convoImportFile({ filePath, wing });
      if (response.success) {
        await this.loadStats();
        return response.data as ConvoImportResult;
      }
      this._error.set(response.error?.message ?? 'Import failed');
      return null;
    } finally {
      this._loading.set(false);
    }
  }

  async detectFormat(content: string): Promise<string | null> {
    const response = await this.memoryIpc.convoDetectFormat({ content });
    if (response.success) {
      return response.data as string;
    }
    return null;
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
