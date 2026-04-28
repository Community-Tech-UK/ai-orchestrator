import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  ArtifactCleanupCandidate,
  ArtifactRegistryRecord,
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
    protectedRoots?: string[];
    allowedRoots?: string[];
  }): Promise<ArtifactCleanupResult> {
    const dryRun = options.dryRun !== false;
    const protectedPaths = new Set((options.protectedPaths ?? []).map((protectedPath) => path.resolve(protectedPath)));
    const protectedRoots = (options.protectedRoots ?? [process.cwd()]).map((root) => path.resolve(root));
    const allowedRoots = options.allowedRoots?.map((root) => path.resolve(root));
    const records = this.store.listCleanupCandidates(options.olderThan, options.limit ?? 100);
    const candidates: ArtifactCleanupCandidate[] = records.map((artifact) => {
      const blockedReason = this.getBlockedReason(artifact, {
        protectedPaths,
        protectedRoots,
        allowedRoots,
      });
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
        await fs.rm(path.resolve(candidate.artifact.path), { recursive: true, force: true });
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

  private getBlockedReason(
    artifact: ArtifactRegistryRecord,
    policy: {
      protectedPaths: Set<string>;
      protectedRoots: string[];
      allowedRoots?: string[];
    },
  ): string | undefined {
    const resolved = path.resolve(artifact.path);
    if (artifact.protected) {
      return 'protected artifact';
    }
    for (const protectedPath of policy.protectedPaths) {
      if (resolved === protectedPath || isPathWithin(resolved, protectedPath)) {
        return 'protected artifact path';
      }
    }
    if (policy.allowedRoots && !policy.allowedRoots.some((root) => isPathWithinOrEqual(resolved, root))) {
      return 'outside allowed cleanup roots';
    }
    if (policy.protectedRoots.some((root) => isPathWithinOrEqual(resolved, root))) {
      return 'protected project/worktree path';
    }
    if (resolved.includes(`${path.sep}.git${path.sep}worktrees${path.sep}`)) {
      return 'protected git worktree path';
    }
    return undefined;
  }
}

function isPathWithinOrEqual(candidate: string, root: string): boolean {
  return candidate === root || isPathWithin(candidate, root);
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
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
