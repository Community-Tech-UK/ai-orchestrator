import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import type {
  RlmMaintenanceProgress,
  RlmMaintenanceRequest,
  RlmMaintenanceResult,
  RlmMaintenanceStage,
  RlmStorageHealth,
} from '../../shared/types/rlm-maintenance.types';
import { getLogger } from '../logging/logger';
import {
  RLM_STALE_STORE_RETENTION_DAYS,
  RLM_STALE_STORE_RETENTION_MS,
  RLM_BACKUP_RETENTION_COUNT,
  RLM_STORAGE_HARD_LIMIT_BYTES,
  RLM_STORAGE_WARNING_BYTES,
} from '../../shared/types/rlm-maintenance.types';

const logger = getLogger('RlmStorageMaintenance');

export interface RlmMaintenanceMeasurement {
  databaseSizeBytes: number;
  externalContentSizeBytes: number;
  reclaimableDatabaseBytes: number;
}

export interface RlmMaintenanceInspection {
  eligibleStoreCount: number;
  protectedLiveStoreCount: number;
  protectedCodebaseAutoStoreCount: number;
}

/**
 * Outcome of reclaiming external content files for pruned stores.
 *
 * `missing` is tracked separately from `failed` on purpose. A file that is not
 * there cannot be reclaimed, but it also is not a failure: content written
 * under a previous userData root has no file under the current one. It is still
 * worth reporting, because "the file wasn't there" is also the signature of a
 * path-derivation bug, and a plain failure count cannot tell the two apart.
 */
export interface ExternalContentCleanupSummary {
  deleted: number;
  missing: number;
  /** Paths that resolved outside the managed content directory. */
  refused: number;
  /** Paths that existed but could not be removed. */
  failed: number;
}

export interface RlmMaintenanceDatabasePort {
  measure(): RlmMaintenanceMeasurement;
  inspect(cutoffTimestamp: number, protectedSessionIds: Set<string>): RlmMaintenanceInspection;
  checkpoint(): void;
  backup(targetPath: string, options: { includeContent: true }): Promise<{ dbBackupPath: string }>;
  verifyBackup(backupPath: string): void;
  prune(cutoffTimestamp: number, protectedSessionIds: Set<string>): {
    storesDeleted: number;
    externalContentFiles: string[];
  };
  deleteExternalContent(files: string[]): ExternalContentCleanupSummary;
  vacuum(): void;
}

export interface RlmStorageMaintenanceDependencies {
  database: RlmMaintenanceDatabasePort;
  getProtectedSessionIds(): Set<string>;
  setMaintenanceGate(active: boolean): void;
  reload(): void | Promise<void>;
  loopExists(loopRunId: string): boolean;
  resumeLoop(loopRunId: string): boolean;
  now(): number;
  createOperationId(): string;
  backupDirectory: string;
  pruneBackups(keepCount: number): { deleted: number; bytesFreed: number; failed: number };
}

interface ActiveOperation {
  operationId: string;
  stage: RlmMaintenanceStage;
  startedAt: number;
}

export class RlmStorageMaintenanceService extends EventEmitter {
  private activeOperation: ActiveOperation | null = null;
  private shutdownRequested = false;
  private lastResult: RlmMaintenanceResult | null = null;

  constructor(private readonly dependencies: RlmStorageMaintenanceDependencies) {
    super();
  }

  isRunning(): boolean {
    return this.activeOperation !== null;
  }

  getStatus(): RlmMaintenanceResult | null {
    return this.activeOperation
      ? { status: 'running', ...this.activeOperation }
      : this.lastResult;
  }

  requestShutdown(): void {
    this.shutdownRequested = true;
  }

  getHealth(): RlmStorageHealth {
    const measured = this.dependencies.database.measure();
    const level = measured.databaseSizeBytes >= RLM_STORAGE_HARD_LIMIT_BYTES
      ? 'critical'
      : measured.databaseSizeBytes >= RLM_STORAGE_WARNING_BYTES
        ? 'warning'
        : 'healthy';
    return {
      ...measured,
      level,
      warningThresholdBytes: RLM_STORAGE_WARNING_BYTES,
      hardLimitBytes: RLM_STORAGE_HARD_LIMIT_BYTES,
      maintenanceRunning: this.isRunning(),
      checkedAt: this.dependencies.now(),
    };
  }

  preview(_request: RlmMaintenanceRequest) {
    const generatedAt = this.dependencies.now();
    const cutoffTimestamp = generatedAt - RLM_STALE_STORE_RETENTION_MS;
    const measured = this.dependencies.database.measure();
    const inspection = this.dependencies.database.inspect(
      cutoffTimestamp,
      this.dependencies.getProtectedSessionIds(),
    );
    return {
      ...measured,
      ...inspection,
      cutoffTimestamp,
      retentionDays: RLM_STALE_STORE_RETENTION_DAYS,
      backupDirectory: this.dependencies.backupDirectory,
      canRun: !this.isRunning()
        && (inspection.eligibleStoreCount > 0 || measured.reclaimableDatabaseBytes > 0),
      generatedAt,
    };
  }

  async run(request: RlmMaintenanceRequest): Promise<RlmMaintenanceResult> {
    if (this.activeOperation) {
      return { status: 'running', ...this.activeOperation };
    }

    const operationId = this.dependencies.createOperationId();
    const startedAt = this.dependencies.now();
    this.activeOperation = { operationId, stage: 'preparing', startedAt };
    this.dependencies.setMaintenanceGate(true);

    let stage: Exclude<RlmMaintenanceStage, 'complete' | 'failed'> = 'preparing';
    let backupPath: string | undefined;
    let storesDeleted = 0;
    let externalContentCleanupFailures = 0;
    let before: RlmMaintenanceMeasurement | null = null;

    try {
      before = this.dependencies.database.measure();
      this.assertCanStartStage();
      // Establish the execution-time candidate set before spending I/O on the
      // backup. This is informational only; pruning recomputes protection once
      // more immediately before the transaction.
      this.dependencies.database.inspect(
        startedAt - RLM_STALE_STORE_RETENTION_MS,
        this.dependencies.getProtectedSessionIds(),
      );
      this.report(stage, 'Checkpointing the RLM database before backup');
      this.dependencies.database.checkpoint();

      stage = 'backing-up';
      this.assertCanStartStage();
      this.report(stage, 'Creating and verifying a database and content backup');
      const targetPath = path.join(
        this.dependencies.backupDirectory,
        `rlm-maintenance-${formatTimestamp(startedAt)}-${operationId}.db`,
      );
      const backup = await this.dependencies.database.backup(targetPath, { includeContent: true });
      this.dependencies.database.verifyBackup(backup.dbBackupPath);
      backupPath = backup.dbBackupPath;

      stage = 'pruning';
      this.assertCanStartStage();
      this.report(stage, 'Pruning stale, unprotected RLM session stores');
      const cutoffTimestamp = this.dependencies.now() - RLM_STALE_STORE_RETENTION_MS;
      const pruned = this.dependencies.database.prune(
        cutoffTimestamp,
        this.dependencies.getProtectedSessionIds(),
      );
      storesDeleted = pruned.storesDeleted;
      const cleanup = this.dependencies.database.deleteExternalContent(
        pruned.externalContentFiles,
      );
      externalContentCleanupFailures = cleanup.refused + cleanup.failed;
      if (cleanup.missing > 0) {
        // Not a failure, but never silent: every one of these is a section the
        // database says has external content that is not where we look for it.
        logger.warn('RLM external content was already absent at its canonical path', {
          operationId,
          missing: cleanup.missing,
          deleted: cleanup.deleted,
          candidates: pruned.externalContentFiles.length,
        });
      }

      stage = 'compacting';
      this.assertCanStartStage();
      this.report(stage, 'Compacting the RLM database');
      this.dependencies.database.checkpoint();
      this.dependencies.database.vacuum();
      this.dependencies.database.checkpoint();

      stage = 'reloading';
      this.assertCanStartStage();
      this.report(stage, 'Reloading RLM context from compacted persistence');
      await this.dependencies.reload();

      const after = this.dependencies.database.measure();
      const backupRetention = this.dependencies.pruneBackups(RLM_BACKUP_RETENTION_COUNT);
      if (backupRetention.failed > 0) {
        logger.warn('Some old RLM maintenance backup paths could not be removed', {
          operationId,
          ...backupRetention,
        });
      }
      const databaseHealthy = after.databaseSizeBytes < RLM_STORAGE_HARD_LIMIT_BYTES;
      const loopResumed = Boolean(
        request.loopRunId
        && databaseHealthy
        && this.dependencies.loopExists(request.loopRunId)
        && this.dependencies.resumeLoop(request.loopRunId),
      );
      this.report('complete', 'RLM storage maintenance completed');
      const result: RlmMaintenanceResult = {
        status: 'success',
        operationId,
        storesDeleted,
        databaseSizeBeforeBytes: before.databaseSizeBytes,
        databaseSizeAfterBytes: after.databaseSizeBytes,
        externalContentSizeBeforeBytes: before.externalContentSizeBytes,
        externalContentSizeAfterBytes: after.externalContentSizeBytes,
        verifiedBytesReclaimed: Math.max(
          0,
          before.databaseSizeBytes + before.externalContentSizeBytes
            - after.databaseSizeBytes - after.externalContentSizeBytes,
        ),
        backupPath: backupPath!,
        backupsPruned: backupRetention.deleted,
        backupBytesFreed: backupRetention.bytesFreed,
        externalContentCleanupFailures,
        loopResumed,
        databaseHealthy,
        completedAt: this.dependencies.now(),
      };
      this.lastResult = result;
      logger.info('RLM storage maintenance completed', {
        operationId,
        storesDeleted,
        databaseSizeBeforeBytes: before.databaseSizeBytes,
        databaseSizeAfterBytes: after.databaseSizeBytes,
        externalContentSizeBeforeBytes: before.externalContentSizeBytes,
        externalContentSizeAfterBytes: after.externalContentSizeBytes,
        verifiedBytesReclaimed: result.status === 'success' ? result.verifiedBytesReclaimed : 0,
        backupsPruned: backupRetention.deleted,
        backupBytesFreed: backupRetention.bytesFreed,
        backupPruneFailures: backupRetention.failed,
        externalContentCleanupFailures,
        loopResumed,
        durationMs: this.dependencies.now() - startedAt,
      });
      return result;
    } catch (error) {
      if (stage === 'compacting') {
        try {
          await this.dependencies.reload();
        } catch {
          // Preserve compaction as the authoritative failure stage.
        }
      }
      this.report('failed', `RLM maintenance failed during ${stage}`);
      const result: RlmMaintenanceResult = {
        status: 'failed',
        operationId,
        failedStage: stage,
        error: error instanceof Error ? error.message : String(error),
        ...(backupPath ? { backupPath } : {}),
        storesDeleted,
        externalContentCleanupFailures,
        completedAt: this.dependencies.now(),
      };
      this.lastResult = result;
      logger.error('RLM storage maintenance failed', error instanceof Error ? error : undefined, {
        operationId,
        failedStage: stage,
        storesDeleted,
        externalContentCleanupFailures,
        verifiedBackupExists: backupPath !== undefined,
        durationMs: this.dependencies.now() - startedAt,
      });
      return result;
    } finally {
      this.activeOperation = null;
      this.dependencies.setMaintenanceGate(false);
    }
  }

  private report(stage: RlmMaintenanceStage, message: string): void {
    if (this.activeOperation) this.activeOperation.stage = stage;
    const progress: RlmMaintenanceProgress = {
      operationId: this.activeOperation?.operationId ?? '',
      stage,
      message,
      startedAt: this.activeOperation?.startedAt ?? this.dependencies.now(),
      updatedAt: this.dependencies.now(),
    };
    this.emit('progress', progress);
    logger.info('RLM storage maintenance stage changed', {
      operationId: progress.operationId,
      stage,
      durationMs: progress.updatedAt - progress.startedAt,
    });
  }

  private assertCanStartStage(): void {
    if (this.shutdownRequested) {
      throw new Error('Application shutdown began during RLM storage maintenance');
    }
  }
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/[-:.]/g, '');
}
