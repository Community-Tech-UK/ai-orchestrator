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
} from '../../shared/types/codebase.types';
import type { AutoIndexingTarget } from './codebase-indexing-auto.types';
import type {
  CodebaseIndexingLaneJob,
  CodebaseIndexingLaneResult,
} from './codebase-indexing-lane-protocol';

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

export interface CodebaseIndexingLaneGatewayOptions {
  runtime?: RuntimeLike;
}

export class CodebaseIndexingLaneGateway extends EventEmitter implements AutoIndexingTarget {
  private readonly runtime: RuntimeLike;

  constructor(options: CodebaseIndexingLaneGatewayOptions = {}) {
    super();
    this.runtime = options.runtime ?? createDefaultRuntime();
    this.runtime.on('progress', (event: { job: BackgroundJobRecord; progress: BackgroundJobProgress }) => {
      if (event.job.lane !== 'indexing' || event.job.type !== 'index-codebase') return;
      this.emit('progress', this.toIndexingProgress(event.progress, event.job));
    });
  }

  async runIndexCodebase(job: CodebaseIndexingLaneJob): Promise<CodebaseIndexingLaneResult> {
    const result = await this.runtime.enqueueAndWait({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'background',
      coalesceKey: job.rootPath,
      payload: job,
      idempotent: true,
    });
    return parseCodebaseIndexingLaneResult(result);
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

export function resetCodebaseIndexingLaneGatewayForTesting(): void {
  codebaseIndexingLaneGatewayInstance = null;
}
