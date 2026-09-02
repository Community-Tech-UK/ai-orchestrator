import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { z } from 'zod';
import {
  BackgroundJobRuntime,
  ProcessLaneGateway,
  type BackgroundJobProgress,
  type BackgroundJobRecord,
  type BackgroundJobSnapshot,
  type BackgroundJobSubmission,
} from '../background-jobs';
import type {
  IndexingProgress,
  IndexingStats,
  IndexingStatus,
  IndexStats,
} from '../../shared/types/codebase.types';
import type { AutoIndexingTarget } from './codebase-indexing-auto.types';
import type {
  CodebaseIndexingLaneJob,
  CodebaseIndexingLaneResult,
  CodebaseIndexingSyncFilesResult,
} from './codebase-indexing-lane-protocol';
import {
  MAX_INDEXING_LANE_BATCH_FILES,
  parseCodebaseIndexingLaneJob,
} from './codebase-indexing-lane-protocol';
import { dispatchWorkerBroadcast } from '../instance/context-worker-event-relay';
import type { ContextWorkerOutboundMsg } from '../instance/context-worker-protocol';

interface RuntimeLike extends EventEmitter {
  enqueueAndWait(submission: BackgroundJobSubmission): Promise<unknown>;
  snapshot(): BackgroundJobSnapshot;
  cancel(jobId: string): Promise<boolean>;
}

const indexingErrorSchema = z.object({
  file: z.string(),
  error: z.string(),
  recoverable: z.boolean(),
});

const codebaseIndexingLaneResultSchema = z.object({
  rootPath: z.string(),
  filesIndexed: z.number().int().nonnegative(),
  chunksCreated: z.number().int().nonnegative(),
  tokensProcessed: z.number().int().nonnegative(),
  duration: z.number().nonnegative(),
  errors: z.array(indexingErrorSchema),
  completedAt: z.number().int().nonnegative(),
});

const indexStatsSchema = z.object({
  storeId: z.string(),
  totalFiles: z.number().int().nonnegative(),
  totalChunks: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  lastIndexedAt: z.number().int().nonnegative(),
  indexSize: z.number().int().nonnegative(),
});

const syncFilesResultSchema = z.object({
  outcomes: z.array(z.object({
    operation: z.enum(['indexed', 'removed']),
    filePath: z.string().min(1).max(4_096),
    success: z.boolean(),
    error: z.string().max(16_384).optional(),
  })).max(MAX_INDEXING_LANE_BATCH_FILES),
});

export interface CodebaseIndexingLaneGatewayOptions {
  runtime?: RuntimeLike;
  userDataPath?: string;
}

export class CodebaseIndexingLaneGateway extends EventEmitter implements AutoIndexingTarget {
  private readonly runtime: RuntimeLike;
  private readonly userDataPath?: string;

  constructor(options: CodebaseIndexingLaneGatewayOptions = {}) {
    super();
    this.runtime = options.runtime ?? createDefaultRuntime();
    this.userDataPath = options.userDataPath ?? getElectronUserDataPath();
    this.runtime.on('progress', (event: { job: BackgroundJobRecord; progress: BackgroundJobProgress }) => {
      if (event.job.lane !== 'indexing' || event.job.type !== 'index-codebase') return;
      this.emit('progress', this.toIndexingProgress(event.progress, event.job));
    });
    // LT-207: receive the indexing lane's normalized RLM DTOs and publish them
    // through the same manager-independent main relay as the context worker.
    this.runtime.on('worker-event', (message: unknown) => {
      dispatchWorkerBroadcast(message as ContextWorkerOutboundMsg);
    });
  }

  async runIndexCodebase(
    job: Extract<CodebaseIndexingLaneJob, { type: 'index-codebase' }>,
  ): Promise<CodebaseIndexingLaneResult> {
    const result = await this.submit(job, 'background', job.rootPath);
    return parseCodebaseIndexingLaneResult(result);
  }

  async indexFile(storeId: string, filePath: string): Promise<void> {
    const result = await this.submit(
      { type: 'index-file', storeId, filePath },
      'normal',
      `${storeId}:${filePath}`,
    );
    assertVoidLaneResult(result);
  }

  async removeFile(storeId: string, filePath: string): Promise<void> {
    const result = await this.submit(
      { type: 'remove-file', storeId, filePath },
      'normal',
      `${storeId}:${filePath}`,
    );
    assertVoidLaneResult(result);
  }

  async getStats(storeId: string): Promise<IndexStats> {
    const result = await this.submit({ type: 'get-stats', storeId }, 'normal', storeId);
    const parsed = indexStatsSchema.safeParse(result);
    if (!parsed.success) {
      throw new Error(`Invalid indexing lane stats result: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  async clearLegacyCodebaseStore(storeId: string): Promise<void> {
    const result = await this.submit({ type: 'clear-legacy-store', storeId }, 'normal', storeId);
    assertVoidLaneResult(result);
  }

  async syncFiles(
    storeId: string,
    deletions: string[],
    upserts: string[],
  ): Promise<CodebaseIndexingSyncFilesResult> {
    const result = await this.submit(
      { type: 'sync-files', storeId, deletions, upserts },
      'background',
      undefined,
    );
    const parsed = syncFilesResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new Error(`Invalid indexing lane sync-files result: ${parsed.error.message}`);
    }
    assertSyncFilesResultMatchesRequest(parsed.data, deletions, upserts);
    return parsed.data;
  }

  async cancelIndexCodebase(rootPath?: string): Promise<number> {
    const snapshot = this.runtime.snapshot();
    const jobs = [...snapshot.queued, ...snapshot.running]
      .filter((job) => this.isMatchingIndexJob(job, rootPath));
    const cancelled = await Promise.all(jobs.map((job) => this.runtime.cancel(job.id)));
    return cancelled.filter(Boolean).length;
  }

  getIndexCodebaseProgress(rootPath?: string): IndexingProgress | null {
    const snapshot = this.runtime.snapshot();
    const running = snapshot.running.find((job) => this.isMatchingIndexJob(job, rootPath));
    if (running) return this.toIndexingProgressFromJob(running);

    const queued = snapshot.queued.find((job) => this.isMatchingIndexJob(job, rootPath));
    if (queued) return this.toIndexingProgressFromJob(queued);

    const terminal = snapshot.terminal
      .filter((job) => this.isMatchingIndexJob(job, rootPath))
      .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))[0];
    return terminal ? this.toIndexingProgressFromJob(terminal) : null;
  }

  async indexCodebase(
    storeId: string,
    rootPath: string,
    options: { force?: boolean } = {},
  ): Promise<IndexingStats> {
    const result = await this.runIndexCodebase({
      type: 'index-codebase',
      rootPath,
      storeId,
      force: options.force,
    });
    return {
      filesIndexed: result.filesIndexed,
      chunksCreated: result.chunksCreated,
      tokensProcessed: result.tokensProcessed,
      duration: result.duration,
      errors: result.errors,
    };
  }

  private async submit(
    job: CodebaseIndexingLaneJob,
    priority: BackgroundJobSubmission['priority'],
    coalesceKey: string | undefined,
  ): Promise<unknown> {
    const payload = parseCodebaseIndexingLaneJob(
      this.userDataPath ? { ...job, userDataPath: this.userDataPath } : job,
    );
    return this.runtime.enqueueAndWait({
      lane: 'indexing',
      type: payload.type,
      priority,
      ...(coalesceKey ? { coalesceKey } : {}),
      payload,
      idempotent: true,
    });
  }

  private toIndexingProgress(
    progress: BackgroundJobProgress,
    job: BackgroundJobRecord,
  ): IndexingProgress {
    const status = toIndexingStatus(progress.phase);
    return {
      status,
      totalFiles: progress.total ?? progress.completed,
      processedFiles: progress.completed,
      totalChunks: 0,
      rootPath: job.coalesceKey,
      currentFile: progress.message,
    };
  }

  private toIndexingProgressFromJob(job: BackgroundJobRecord): IndexingProgress {
    if (job.progress) {
      return this.toIndexingProgress(job.progress, job);
    }
    return {
      status: toIndexingStatusFromJobStatus(job.status),
      totalFiles: 0,
      processedFiles: 0,
      totalChunks: 0,
      rootPath: job.coalesceKey,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      errorMessage: job.errorMessage,
    };
  }

  private isMatchingIndexJob(job: BackgroundJobRecord, rootPath?: string): boolean {
    if (job.lane !== 'indexing' || job.type !== 'index-codebase') {
      return false;
    }
    if (!rootPath) {
      return true;
    }
    return normalizePathForMatch(job.coalesceKey) === normalizePathForMatch(rootPath);
  }
}

function assertSyncFilesResultMatchesRequest(
  result: CodebaseIndexingSyncFilesResult,
  deletions: string[],
  upserts: string[],
): void {
  const expected = [
    ...deletions.map((filePath) => ({ operation: 'removed' as const, filePath })),
    ...upserts.map((filePath) => ({ operation: 'indexed' as const, filePath })),
  ];
  const seen = new Set<string>();
  const matches = result.outcomes.length === expected.length
    && result.outcomes.every((outcome, index) => {
      const key = `${outcome.operation}\0${outcome.filePath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const requested = expected[index];
      return requested?.operation === outcome.operation && requested.filePath === outcome.filePath;
    });
  if (!matches) {
    throw new Error('Indexing lane sync-files result does not exactly match requested files');
  }
}

function toIndexingStatusFromJobStatus(status: BackgroundJobRecord['status']): IndexingStatus {
  if (status === 'succeeded') return 'complete';
  if (status === 'failed' || status === 'stale') return 'error';
  if (status === 'cancelled') return 'cancelled';
  return 'scanning';
}

function parseCodebaseIndexingLaneResult(result: unknown): CodebaseIndexingLaneResult {
  const parsed = codebaseIndexingLaneResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`Invalid indexing lane result: ${parsed.error.message}`);
  }
  return parsed.data;
}

function assertVoidLaneResult(result: unknown): asserts result is undefined {
  if (result !== undefined) {
    throw new Error('Invalid indexing lane void result');
  }
}

function normalizePathForMatch(candidate: string | undefined): string | null {
  if (!candidate) {
    return null;
  }
  try {
    return path.resolve(candidate);
  } catch {
    return candidate;
  }
}

function toIndexingStatus(phase: string): IndexingStatus {
  if (
    phase === 'idle'
    || phase === 'scanning'
    || phase === 'chunking'
    || phase === 'complete'
    || phase === 'error'
    || phase === 'cancelled'
  ) {
    return phase;
  }
  return 'chunking';
}

function createDefaultRuntime(): RuntimeLike {
  const lane = new ProcessLaneGateway({
    lane: 'indexing',
    entrypoint: path.join(__dirname, 'codebase-indexing-lane-main.js'),
    transient: true,
  });
  return new BackgroundJobRuntime({
    lanes: { indexing: lane },
    maxPendingPerLane: { indexing: 8 },
    laneHeartbeatTimeoutMs: { indexing: 60_000 },
  });
}

let codebaseIndexingLaneGatewayInstance: CodebaseIndexingLaneGateway | null = null;

export function getCodebaseIndexingLaneGateway(): CodebaseIndexingLaneGateway {
  if (!codebaseIndexingLaneGatewayInstance) {
    codebaseIndexingLaneGatewayInstance = new CodebaseIndexingLaneGateway();
  }
  return codebaseIndexingLaneGatewayInstance;
}

function getElectronUserDataPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron');
    return electron.app?.getPath?.('userData');
  } catch {
    return undefined;
  }
}

export function resetCodebaseIndexingLaneGatewayForTesting(): void {
  codebaseIndexingLaneGatewayInstance = null;
}
