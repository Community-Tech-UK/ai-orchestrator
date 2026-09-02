import type { RLMDatabase } from '../persistence/rlm-database';
import { getLogger } from '../logging/logger';
import { getRlmProcessRole } from './context-persistence-loader';
import type { VectorStore } from './vector-store';

const logger = getLogger('SemanticVectorDeltaRepair');

export interface SemanticVectorDeltaResult {
  missing: number;
  indexed: number;
  skipped: number;
  failed: number;
  retried: number;
}

export interface SemanticVectorDeltaSummary {
  missing: number;
  indexed: number;
  skipped: number;
  failed: number;
  retried: number;
  elapsedMs: number;
}

interface SemanticVectorDeltaRepairOptions {
  onSummary?: (summary: Readonly<SemanticVectorDeltaSummary>, generation: number) => void;
}

/**
 * Coordinates durable semantic-vector gap repair without hydrating a store's
 * section graph. Vector-row presence is the only completed-work checkpoint.
 */
export class SemanticVectorDeltaRepair {
  private readonly pending = new Map<string, Promise<SemanticVectorDeltaResult>>();
  private generation = 0;
  private reloadBarrier: Promise<void> = Promise.resolve();
  private readonly retryableSectionIds = new Set<string>();

  constructor(
    private readonly db: RLMDatabase,
    private readonly vectorStore: VectorStore,
    private readonly options: SemanticVectorDeltaRepairOptions = {},
  ) {}

  repairStore(storeId: string): Promise<SemanticVectorDeltaResult> {
    const existing = this.pending.get(storeId);
    if (existing) return existing;

    const generation = this.generation;
    const repair = this.reloadBarrier.then(() => this.runRepair(storeId, generation));
    this.pending.set(storeId, repair);
    const clear = (): void => {
      if (this.pending.get(storeId) === repair) this.pending.delete(storeId);
    };
    void repair.then(clear, clear);
    return repair;
  }

  /** Fence replacement-state repair behind every write from the old graph. */
  invalidateForReload(): void {
    this.generation += 1;
    this.retryableSectionIds.clear();
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    if (inFlight.length > 0) {
      this.reloadBarrier = Promise
        .allSettled([this.reloadBarrier, ...inFlight])
        .then(() => undefined);
    }
  }

  private async runRepair(
    storeId: string,
    generation: number,
  ): Promise<SemanticVectorDeltaResult> {
    const startedAt = Date.now();
    const batchSize = Math.max(1, Math.floor(this.vectorStore.getConfig().indexBatchSize));
    const addedSectionIds: string[] = [];
    let missingCount = 0;
    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    let retried = 0;

    while (generation === this.generation) {
      const missing = this.db.listUnindexedRootSections(storeId, { limit: batchSize });
      if (missing.length === 0) break;
      missingCount += missing.length;

      let batchFailed = false;
      for (const candidate of missing) {
        if (generation !== this.generation) break;
        if (this.retryableSectionIds.has(candidate.id)) retried += 1;

        const section = this.db.getSection(candidate.id);
        if (!section || section.store_id !== storeId || section.depth !== 0) {
          skipped += 1;
          this.retryableSectionIds.delete(candidate.id);
          continue;
        }

        try {
          const content = this.db.getSectionContent(section);
          await this.vectorStore.addSection(storeId, section.id, content, {
            type: candidate.type,
            name: candidate.name,
            filePath: candidate.file_path ?? undefined,
            language: candidate.language ?? undefined,
          }, { existingSectionOnly: true });
          addedSectionIds.push(section.id);
          indexed += 1;
          this.retryableSectionIds.delete(candidate.id);
        } catch (error) {
          failed += 1;
          batchFailed = true;
          if (generation === this.generation) this.retryableSectionIds.add(candidate.id);
          void error;
        }
      }

      if (generation !== this.generation) {
        return this.finishStale(
          startedAt, generation, missingCount, indexed, skipped, failed, retried, addedSectionIds,
        );
      }
      // Do not immediately select a failed row again. Its absent vector makes
      // it eligible for the next query's repair attempt.
      if (batchFailed || missing.length < batchSize) break;
      await yieldToEventLoop();
    }

    if (generation !== this.generation) {
      return this.finishStale(
        startedAt, generation, missingCount, indexed, skipped, failed, retried, addedSectionIds,
      );
    }
    return this.finish(startedAt, generation, {
      missing: missingCount, indexed, skipped, failed, retried,
    });
  }

  private finishStale(
    startedAt: number,
    generation: number,
    missing: number,
    indexed: number,
    skipped: number,
    failed: number,
    retried: number,
    addedSectionIds: readonly string[],
  ): SemanticVectorDeltaResult {
    this.removeStaleVectors(addedSectionIds);
    const unattempted = Math.max(0, missing - indexed - skipped - failed);
    return this.finish(startedAt, generation, {
      missing,
      indexed: 0,
      skipped: skipped + indexed + unattempted,
      failed,
      retried,
    });
  }

  private finish(
    startedAt: number,
    generation: number,
    counts: Omit<SemanticVectorDeltaSummary, 'elapsedMs'>,
  ): SemanticVectorDeltaResult {
    const summary = Object.freeze({
      ...counts,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    });
    logger.info('RLM semantic delta summary', {
      processRole: getRlmProcessRole(),
      ...summary,
    });
    this.options.onSummary?.(summary, generation);
    return {
      missing: summary.missing,
      indexed: summary.indexed,
      skipped: summary.skipped,
      failed: summary.failed,
      retried: summary.retried,
    };
  }

  private removeStaleVectors(sectionIds: readonly string[]): void {
    for (const sectionId of sectionIds) this.vectorStore.removeSection(sectionId);
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
