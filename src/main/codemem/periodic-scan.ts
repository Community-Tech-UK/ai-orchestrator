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

export class PeriodicScan {
  constructor(private readonly opts: PeriodicScanOptions) {}

  async runOnce(workspaceHash: WorkspaceHash): Promise<{ scanned: number; mismatched: number; reindexed: boolean }> {
    const workspaceRoot = this.opts.store.getWorkspaceRoot(workspaceHash);
    if (!workspaceRoot) {
      return { scanned: 0, mismatched: 0, reindexed: false };
    }

    const manifestEntries = this.opts.store.listManifestEntries(workspaceHash);
    const sampleSize = Math.min(this.opts.sampleSize ?? 100, manifestEntries.length);
    const sample = this.takeDeterministicSample(manifestEntries, sampleSize);

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

    const threshold = this.opts.mismatchThreshold ?? 0.05;
    const rate = sampleSize === 0 ? 0 : mismatched / sampleSize;
    if (rate <= threshold && !(threshold === 0 && mismatched > 0)) {
      return { scanned: sampleSize, mismatched, reindexed: false };
    }

    for (const absolutePath of mismatchedPaths) {
      await this.opts.mgr.onFileChange(absolutePath, workspaceHash);
    }

    return { scanned: sampleSize, mismatched, reindexed: mismatchedPaths.length > 0 };
  }

  private takeDeterministicSample<T>(items: T[], sampleSize: number): T[] {
    return [...items]
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      .slice(0, sampleSize);
  }
}
