import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { CodeIndexManager } from './code-index-manager';
import type { CasStore } from './cas-store';
import type { WorkspaceHash } from './types';

export interface PeriodicScanOptions {
  store: CasStore;
  mgr: CodeIndexManager;
  mismatchThreshold?: number;
  sampleSize?: number;
}

export interface PeriodicScanResult {
  scanned: number;
  mismatched: number;
  reindexed: boolean;
  escalated: boolean;
}

export class PeriodicScan {
  /** Per-workspace rotating offset so successive scans cover the whole manifest. */
  private readonly cursors = new Map<WorkspaceHash, number>();

  constructor(private readonly opts: PeriodicScanOptions) {}

  async runOnce(workspaceHash: WorkspaceHash): Promise<PeriodicScanResult> {
    const workspaceRoot = this.opts.store.getWorkspaceRoot(workspaceHash);
    if (!workspaceRoot) {
      return { scanned: 0, mismatched: 0, reindexed: false, escalated: false };
    }

    const manifestEntries = this.opts.store.countManifestEntries(workspaceHash);
    const sampleSize = Math.min(this.opts.sampleSize ?? 100, manifestEntries);
    const sample = this.takeRotatingSample(workspaceHash, manifestEntries, sampleSize);

    let mismatched = 0;
    const mismatchedPaths: string[] = [];

    for (const entry of sample) {
      const absolutePath = path.join(workspaceRoot.absPath, entry.pathFromRoot);
      try {
        const stat = await fs.stat(absolutePath);
        const fileContents = await fs.readFile(absolutePath, 'utf8');
        const fileHash = createHash('sha256').update(fileContents).digest('hex');
        if (Math.floor(stat.mtimeMs) !== entry.mtime || fileHash !== entry.contentHash) {
          mismatched++;
          mismatchedPaths.push(absolutePath);
        }
      } catch {
        mismatched++;
        mismatchedPaths.push(absolutePath);
      }
    }

    // Always repair what the sample found — a mismatch below the threshold is
    // still a stale entry that agents would read.
    for (const absolutePath of mismatchedPaths) {
      await this.opts.mgr.onFileChange(absolutePath, workspaceHash);
    }

    // High drift in the sample means the unsampled remainder has likely
    // drifted too (bulk change while unwatched) — reconcile the whole index.
    const threshold = this.opts.mismatchThreshold ?? 0.05;
    const rate = sampleSize === 0 ? 0 : mismatched / sampleSize;
    const escalated = mismatched > 0 && rate > threshold;
    if (escalated) {
      await this.opts.mgr.reconcileIndex(workspaceRoot.absPath);
    }

    return { scanned: sampleSize, mismatched, reindexed: mismatchedPaths.length > 0, escalated };
  }

  private takeRotatingSample(
    workspaceHash: WorkspaceHash,
    manifestEntries: number,
    sampleSize: number,
  ): ReturnType<CasStore['listManifestEntries']> {
    if (sampleSize === 0) {
      return [];
    }

    const offset = (this.cursors.get(workspaceHash) ?? 0) % manifestEntries;
    const sample = this.opts.store.listManifestEntries(workspaceHash, { limit: sampleSize, offset });
    if (sample.length < sampleSize && offset > 0) {
      sample.push(...this.opts.store.listManifestEntries(workspaceHash, {
        limit: sampleSize - sample.length,
        offset: 0,
      }));
    }

    this.cursors.set(workspaceHash, (offset + sampleSize) % manifestEntries);
    return sample;
  }
}
