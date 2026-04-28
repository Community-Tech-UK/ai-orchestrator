import * as fs from 'fs/promises';
import type {
  ArtifactCleanupCandidate,
  ArtifactCleanupResult,
} from '../../shared/types/artifact-cleanup.types';
import { emitPluginHook } from '../plugins/hook-emitter';
import { ArtifactAttributionStore, getArtifactAttributionStore } from './artifact-attribution-store';

export class ArtifactCleanupService {
  constructor(private readonly store: ArtifactAttributionStore = getArtifactAttributionStore()) {}

  async cleanup(options: {
    olderThan: number;
    dryRun?: boolean;
    limit?: number;
    protectedPaths?: string[];
  }): Promise<ArtifactCleanupResult> {
    const dryRun = options.dryRun !== false;
    const protectedPaths = new Set(options.protectedPaths ?? []);
    const records = this.store.listCleanupCandidates(options.olderThan, options.limit ?? 100);
    const candidates: ArtifactCleanupCandidate[] = records.map((artifact) => {
      const blockedReason = artifact.protected || protectedPaths.has(artifact.path)
        ? 'protected artifact path'
        : undefined;
      return {
        artifact,
        reason: `last seen before ${options.olderThan}`,
        wouldRemove: blockedReason === undefined,
        blockedReason,
      };
    });
    const removed: string[] = [];
    const errors: Array<{ artifactId: string; error: string }> = [];

    for (const candidate of candidates) {
      emitPluginHook('cleanup.candidate.before', {
        artifactId: candidate.artifact.id,
        path: candidate.artifact.path,
        reason: candidate.reason,
        dryRun,
        timestamp: Date.now(),
      });

      if (!candidate.wouldRemove || dryRun) {
        emitPluginHook('cleanup.candidate.after', {
          artifactId: candidate.artifact.id,
          path: candidate.artifact.path,
          reason: candidate.reason,
          removed: false,
          dryRun,
          timestamp: Date.now(),
        });
        continue;
      }

      try {
        await fs.rm(candidate.artifact.path, { recursive: true, force: true });
        this.store.delete(candidate.artifact.id);
        removed.push(candidate.artifact.id);
        emitPluginHook('cleanup.candidate.after', {
          artifactId: candidate.artifact.id,
          path: candidate.artifact.path,
          reason: candidate.reason,
          removed: true,
          dryRun,
          timestamp: Date.now(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ artifactId: candidate.artifact.id, error: message });
        emitPluginHook('cleanup.candidate.after', {
          artifactId: candidate.artifact.id,
          path: candidate.artifact.path,
          reason: candidate.reason,
          removed: false,
          error: message,
          dryRun,
          timestamp: Date.now(),
        });
      }
    }

    return { dryRun, candidates, removed, errors };
  }
}

let artifactCleanupService: ArtifactCleanupService | null = null;

export function getArtifactCleanupService(): ArtifactCleanupService {
  if (!artifactCleanupService) {
    artifactCleanupService = new ArtifactCleanupService();
  }
  return artifactCleanupService;
}

export function _resetArtifactCleanupServiceForTesting(): void {
  artifactCleanupService = null;
}
