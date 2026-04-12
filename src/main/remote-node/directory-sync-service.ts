/**
 * Coordinator-side orchestration service for directory sync.
 *
 * Implements the 4-phase rsync-style sync flow:
 *   1. Scan — scan both source and target directories.
 *   2. Compare — compare manifests to find added / removed / modified files.
 *   3. Transfer — delta-transfer modified files, full-copy added files, delete removed files.
 *   4. Complete — report results.
 *
 * Supports both local-to-remote and remote-to-local sync jobs. The coordinator
 * currently does not support remote-to-remote or local-to-local sync.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getLogger } from '../logging/logger';
import { getWorkerNodeConnectionServer } from './worker-node-connection';
import { getWorkerNodeRegistry } from './worker-node-registry';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';
import { scanDirectory } from './sync/directory-scanner';
import { diffManifests } from './sync/directory-diff';
import { computeBlockSignatures } from './sync/block-signature';
import { computeDelta, estimateDeltaWireSize } from './sync/delta-generator';
import type {
  DirectoryDiff,
  FileDelta,
  FileSignatures,
  SyncError,
  SyncJobParams,
  SyncManifest,
  SyncPhase,
  SyncProgress,
  SyncResult,
} from '../../shared/types/sync.types';
import { DEFAULT_BLOCK_SIZE, MAX_DELTA_FILE_SIZE } from '../../shared/types/sync.types';
import type { FsReadFileResult } from '../../shared/types/remote-fs.types';

const logger = getLogger('DirectorySyncService');

/** RPC timeout for sync operations: 5 minutes */
const SYNC_RPC_TIMEOUT_MS = 300_000;

interface LegacySyncJobParams {
  nodeId: string;
  localPath: string;
  remotePath: string;
  direction: 'push' | 'pull';
  exclude?: string[];
  blockSize?: number;
  dryRun?: boolean;
  deleteExtraneous?: boolean;
}

interface SyncEndpointKinds {
  local: 'local';
  remote: 'remote';
}

type SyncEndpointKind = keyof SyncEndpointKinds;

interface NormalizedSyncJobParams {
  remoteNodeId: string;
  sourceKind: SyncEndpointKind;
  sourcePath: string;
  targetKind: SyncEndpointKind;
  targetPath: string;
  exclude?: string[];
  blockSize?: number;
  dryRun?: boolean;
  deleteExtraneous: boolean;
}

function isLegacySyncJobParams(params: SyncJobParams | LegacySyncJobParams): params is LegacySyncJobParams {
  return 'direction' in params;
}

function isLocalNode(nodeId: string): boolean {
  return nodeId === 'local' || nodeId === 'coordinator' || nodeId === '';
}

function normalizeSyncParams(params: SyncJobParams | LegacySyncJobParams): NormalizedSyncJobParams {
  if (isLegacySyncJobParams(params)) {
    if (params.direction === 'push') {
      return {
        remoteNodeId: params.nodeId,
        sourceKind: 'local',
        sourcePath: params.localPath,
        targetKind: 'remote',
        targetPath: params.remotePath,
        exclude: params.exclude,
        blockSize: params.blockSize,
        dryRun: params.dryRun,
        deleteExtraneous: params.deleteExtraneous ?? false,
      };
    }

    return {
      remoteNodeId: params.nodeId,
      sourceKind: 'remote',
      sourcePath: params.remotePath,
      targetKind: 'local',
      targetPath: params.localPath,
      exclude: params.exclude,
      blockSize: params.blockSize,
      dryRun: params.dryRun,
      deleteExtraneous: params.deleteExtraneous ?? false,
    };
  }

  const sourceIsLocal = isLocalNode(params.sourceNodeId);
  const targetIsLocal = isLocalNode(params.targetNodeId);

  if (sourceIsLocal === targetIsLocal) {
    throw new Error('DirectorySyncService only supports local<->remote sync jobs');
  }

  return {
    remoteNodeId: sourceIsLocal ? params.targetNodeId : params.sourceNodeId,
    sourceKind: sourceIsLocal ? 'local' : 'remote',
    sourcePath: params.sourcePath,
    targetKind: targetIsLocal ? 'local' : 'remote',
    targetPath: params.targetPath,
    exclude: params.exclude,
    blockSize: params.blockSize,
    dryRun: params.dryRun,
    deleteExtraneous: params.deleteExtraneous ?? false,
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: DirectorySyncService | null = null;

export class DirectorySyncService {
  /** Active sync jobs keyed by a job id (uuid). */
  private jobs = new Map<string, SyncJob>();

  static getInstance(): DirectorySyncService {
    if (!instance) {
      instance = new DirectorySyncService();
    }
    return instance;
  }

  static _resetForTesting(): void {
    instance = null;
  }

  /**
   * Start a sync job. Returns a job id that can be used to query progress /
   * cancel the job.
   */
  async startSync(params: SyncJobParams | LegacySyncJobParams): Promise<string> {
    const normalized = normalizeSyncParams(params);
    const registry = getWorkerNodeRegistry();
    const node = registry.getNode(normalized.remoteNodeId);
    if (!node) {
      throw new Error(`Node not found: ${normalized.remoteNodeId}`);
    }

    const jobId = crypto.randomUUID();
    const job = new SyncJob(jobId, normalized);
    this.jobs.set(jobId, job);

    void job.run().catch((error) => {
      logger.error('Sync job failed', error instanceof Error ? error : new Error(String(error)), { jobId });
    });

    return jobId;
  }

  getProgress(jobId: string): SyncProgress | undefined {
    return this.jobs.get(jobId)?.progress;
  }

  cancelSync(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) {
      return false;
    }
    job.cancel();
    return true;
  }

  /**
   * Run a diff without transferring anything.
   */
  async diffOnly(params: SyncJobParams | LegacySyncJobParams): Promise<DirectoryDiff> {
    const normalized = normalizeSyncParams(params);
    const { sourceManifest, targetManifest } = await this.scanBothSides(normalized);
    return diffManifests(sourceManifest, targetManifest);
  }

  // ---------------------------------------------------------------------------
  // Helpers shared with SyncJob
  // ---------------------------------------------------------------------------

  async scanBothSides(params: NormalizedSyncJobParams): Promise<{
    sourceManifest: SyncManifest;
    targetManifest: SyncManifest;
  }> {
    const server = getWorkerNodeConnectionServer();
    const { remoteNodeId, sourceKind, sourcePath, targetKind, targetPath, exclude } = params;

    if (sourceKind === 'local' && targetKind === 'remote') {
      const [sourceManifest, targetManifest] = await Promise.all([
        scanDirectory(sourcePath, exclude),
        server.sendRpc<SyncManifest>(
          remoteNodeId,
          COORDINATOR_TO_NODE.SYNC_SCAN_DIRECTORY,
          { path: targetPath, exclude },
          SYNC_RPC_TIMEOUT_MS,
        ),
      ]);
      return { sourceManifest, targetManifest };
    }

    const [sourceManifest, targetManifest] = await Promise.all([
      server.sendRpc<SyncManifest>(
        remoteNodeId,
        COORDINATOR_TO_NODE.SYNC_SCAN_DIRECTORY,
        { path: sourcePath, exclude },
        SYNC_RPC_TIMEOUT_MS,
      ),
      scanDirectory(targetPath, exclude),
    ]);
    return { sourceManifest, targetManifest };
  }
}

export function getDirectorySyncService(): DirectorySyncService {
  return DirectorySyncService.getInstance();
}

// ---------------------------------------------------------------------------
// SyncJob — internal class driving a single sync run
// ---------------------------------------------------------------------------

class SyncJob {
  progress: SyncProgress;
  private cancelled = false;

  constructor(
    private readonly jobId: string,
    private readonly params: NormalizedSyncJobParams,
  ) {
    this.progress = {
      jobId,
      phase: 'scanning',
      totalFiles: 0,
      processedFiles: 0,
      totalBytes: 0,
      transferredBytes: 0,
    };
  }

  cancel(): void {
    this.cancelled = true;
    this.progress.phase = 'cancelled';
    this.progress.error = 'Cancelled by user';
  }

  async run(): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];

    try {
      this.setPhase('scanning');
      const service = DirectorySyncService.getInstance();
      const { sourceManifest, targetManifest } = await service.scanBothSides(this.params);
      if (this.cancelled) {
        return this.abortedResult(start, errors);
      }

      this.setPhase('comparing');
      const diff = diffManifests(sourceManifest, targetManifest);
      const removedEntries = this.params.deleteExtraneous ? diff.removed : [];
      const totalBytesLogical =
        diff.added.reduce((sum, entry) => sum + entry.size, 0)
        + diff.modified.reduce((sum, entry) => sum + entry.sourceEntry.size, 0);

      this.progress.totalFiles = diff.added.length + diff.modified.length + removedEntries.length;
      this.progress.totalBytes = totalBytesLogical;

      if (this.params.dryRun) {
        this.setPhase('complete');
        return {
          jobId: this.jobId,
          added: diff.added.length,
          removed: removedEntries.length,
          modified: diff.modified.length,
          identical: diff.identical.length,
          totalBytesTransferred: 0,
          totalBytesLogical,
          durationMs: Date.now() - start,
          errors,
          diff,
        };
      }

      this.setPhase('transferring');

      for (const entry of diff.added) {
        if (this.cancelled) {
          return this.abortedResult(start, errors);
        }
        this.progress.currentFile = entry.relativePath;
        try {
          await this.transferNewFile(entry.relativePath);
          this.progress.transferredBytes += entry.size;
        } catch (error) {
          errors.push({
            relativePath: entry.relativePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.progress.processedFiles++;
      }

      for (const entry of diff.modified) {
        if (this.cancelled) {
          return this.abortedResult(start, errors);
        }
        this.progress.currentFile = entry.relativePath;
        try {
          await this.transferModifiedFile(entry.relativePath, entry.sourceEntry.size);
          this.progress.transferredBytes += entry.sourceEntry.size;
        } catch (error) {
          errors.push({
            relativePath: entry.relativePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.progress.processedFiles++;
      }

      for (const entry of removedEntries) {
        if (this.cancelled) {
          return this.abortedResult(start, errors);
        }
        this.progress.currentFile = entry.relativePath;
        try {
          await this.deleteFile(entry.relativePath);
        } catch (error) {
          errors.push({
            relativePath: entry.relativePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.progress.processedFiles++;
      }

      this.setPhase('complete');
      const result: SyncResult = {
        jobId: this.jobId,
        added: diff.added.length,
        removed: removedEntries.length,
        modified: diff.modified.length,
        identical: diff.identical.length,
        totalBytesTransferred: this.progress.transferredBytes,
        totalBytesLogical,
        durationMs: Date.now() - start,
        errors,
        diff,
      };

      logger.info('Sync completed', {
        jobId: result.jobId,
        added: result.added,
        removed: result.removed,
        modified: result.modified,
        identical: result.identical,
        totalBytesTransferred: result.totalBytesTransferred,
        totalBytesLogical: result.totalBytesLogical,
        durationMs: result.durationMs,
        errorCount: result.errors.length,
      });

      return result;
    } catch (error) {
      this.progress.phase = 'error';
      this.progress.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * Copy a brand-new file from source to target.
   * For local->remote: read local → write remote.
   * For remote->local: read remote → write local.
   */
  private async transferNewFile(relativePath: string): Promise<void> {
    const server = getWorkerNodeConnectionServer();
    const { remoteNodeId, sourceKind, sourcePath, targetPath } = this.params;

    if (sourceKind === 'local') {
      const absSource = path.join(sourcePath, relativePath);
      const content = await fs.readFile(absSource);
      await server.sendRpc(
        remoteNodeId,
        COORDINATOR_TO_NODE.FS_WRITE_FILE,
        {
          path: path.posix.join(targetPath, relativePath),
          data: content.toString('base64'),
          mkdirp: true,
        },
        SYNC_RPC_TIMEOUT_MS,
      );
      return;
    }

    const result = await server.sendRpc<FsReadFileResult>(
      remoteNodeId,
      COORDINATOR_TO_NODE.FS_READ_FILE,
      { path: path.posix.join(sourcePath, relativePath) },
      SYNC_RPC_TIMEOUT_MS,
    );
    const absTarget = path.join(targetPath, relativePath);
    await fs.mkdir(path.dirname(absTarget), { recursive: true });
    await fs.writeFile(absTarget, Buffer.from(result.data, 'base64'));
  }

  /**
   * Delta-transfer a modified file.
   */
  private async transferModifiedFile(relativePath: string, sourceSize: number): Promise<void> {
    const blockSize = this.params.blockSize ?? DEFAULT_BLOCK_SIZE;
    if (sourceSize <= blockSize * 2) {
      await this.transferNewFile(relativePath);
      return;
    }

    const server = getWorkerNodeConnectionServer();
    const { remoteNodeId, sourceKind, sourcePath, targetPath } = this.params;

    if (sourceKind === 'local') {
      const targetSignatures = await server.sendRpc<FileSignatures>(
        remoteNodeId,
        COORDINATOR_TO_NODE.SYNC_GET_BLOCK_SIGNATURES,
        { path: targetPath, relativePath, blockSize },
        SYNC_RPC_TIMEOUT_MS,
      );

      const absSource = path.join(sourcePath, relativePath);
      const delta = await computeDelta(absSource, targetSignatures);
      const deltaWireSize = estimateDeltaWireSize(delta);
      if (deltaWireSize > MAX_DELTA_FILE_SIZE || deltaWireSize > sourceSize) {
        await this.transferNewFile(relativePath);
        return;
      }

      await server.sendRpc(
        remoteNodeId,
        COORDINATOR_TO_NODE.SYNC_APPLY_DELTA,
        { path: targetPath, delta },
        SYNC_RPC_TIMEOUT_MS,
      );
      return;
    }

    const absTarget = path.join(targetPath, relativePath);
    const localSignatures = await computeBlockSignatures(absTarget, relativePath, blockSize);
    const delta = await server.sendRpc<FileDelta>(
      remoteNodeId,
      COORDINATOR_TO_NODE.SYNC_COMPUTE_DELTA,
      { path: sourcePath, targetSignatures: localSignatures },
      SYNC_RPC_TIMEOUT_MS,
    );

    const deltaWireSize = estimateDeltaWireSize(delta);
    if (deltaWireSize > MAX_DELTA_FILE_SIZE || deltaWireSize > sourceSize) {
      await this.transferNewFile(relativePath);
      return;
    }

    const { applyDelta } = await import('./sync/delta-applier');
    const tmpPath = `${absTarget}.sync-tmp`;
    await applyDelta(tmpPath, delta, absTarget, blockSize);
    await fs.rename(tmpPath, absTarget);
  }

  /**
   * Delete a file on the target side.
   */
  private async deleteFile(relativePath: string): Promise<void> {
    const server = getWorkerNodeConnectionServer();
    const { remoteNodeId, sourceKind, targetPath } = this.params;

    if (sourceKind === 'local') {
      await server.sendRpc(
        remoteNodeId,
        COORDINATOR_TO_NODE.SYNC_DELETE_FILE,
        { path: path.posix.join(targetPath, relativePath) },
        SYNC_RPC_TIMEOUT_MS,
      );
      return;
    }

    const absTarget = path.join(targetPath, relativePath);
    try {
      await fs.unlink(absTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private setPhase(phase: SyncPhase): void {
    this.progress.phase = phase;
    logger.info(`Sync phase: ${phase}`, { jobId: this.jobId });
  }

  private abortedResult(startTime: number, errors: SyncError[]): SyncResult {
    return {
      jobId: this.jobId,
      added: 0,
      removed: 0,
      modified: 0,
      identical: 0,
      totalBytesTransferred: this.progress.transferredBytes,
      totalBytesLogical: this.progress.totalBytes,
      durationMs: Date.now() - startTime,
      errors: [...errors, { relativePath: '', error: 'Cancelled by user' }],
    };
  }
}
