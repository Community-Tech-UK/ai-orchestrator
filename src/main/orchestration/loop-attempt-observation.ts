/**
 * WS5 (loop-convergence plan) — invoker-side workspace-effect observation.
 *
 * Captures the before-snapshot when an attempt starts and observes the delta
 * on BOTH the success and error paths (try/finally shape), so a thrown or
 * timed-out attempt still reports what it did to the workspace. An observer
 * failure yields `null` (evidence: `unknown`) — never a claimed-clean delta.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LoopFileChange } from '../../shared/types/loop-state.types';
import {
  ATTEMPT_EVIDENCE_EXCERPT_CHARS,
  ATTEMPT_EVIDENCE_MAX_FILES,
  type LoopInvocationAttemptEvidence,
} from './loop-invocation-attempt';
import {
  mergeFileChanges,
  snapshotWorkspaceDelta,
  snapshotWorkspaceFiles,
  type WorkspaceObservationCoverage,
  type WorkspaceSnapshotOptions,
} from './loop-workspace-snapshot';
import { captureLoopRepoBaseline, compareLoopRepoState } from './loop-repo-state';
import { discoverWorkspaceRepositories } from './loop-workspace-repositories';

export type WorkspaceObservationSource = 'workspace-git' | 'nested-git' | 'filesystem';

export interface WorkspaceDeltaObservation {
  changes: LoopFileChange[];
  coverage: WorkspaceObservationCoverage;
  sources: WorkspaceObservationSource[];
  reason?: string;
}

export interface AttemptDeltaObserver {
  observe(): WorkspaceDeltaObservation;
  /** The observer-failure note, when any capture step failed. */
  failureNote(): string | null;
}

/**
 * `git rev-parse --show-toplevel` always returns the REAL (symlink-resolved)
 * path, but a caller's `workspaceDir` may reach us through a symlink (e.g.
 * anything under macOS's `/tmp`, which is `/private/tmp`). If the observer's
 * own `workspace` stayed un-resolved, `discoverWorkspaceRepositories`'s
 * authoritative git root would diverge from it by exactly the symlink
 * prefix, and every `path.relative(workspace, absolutePath)` computed in
 * `toWorkspaceFileChange` would start with `../` and be silently dropped —
 * a real write would report as no observed change (LT-065). Resolve
 * symlinks up front so `workspace` matches whatever git reports; fall back
 * to a plain absolute path when the target doesn't exist yet (e.g. the
 * "workspace cannot be read" case), where realpath would throw.
 */
function resolveWorkspaceRoot(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Capture the before-snapshots now; failures are recorded, never thrown. */
export function createAttemptDeltaObserver(
  workspaceDir: string,
  options: WorkspaceSnapshotOptions = {},
): AttemptDeltaObserver {
  const workspace = resolveWorkspaceRoot(workspaceDir);
  const discovery = discoverWorkspaceRepositories(workspace);
  const repoBaselines = discovery.roots.map((root) => ({
    root,
    baseline: captureLoopRepoBaseline(root),
  }));
  const excludedRelativeDirs = discovery.authoritativeRoot
    ? []
    : discovery.roots
        .map((root) => path.relative(workspace, root))
        .filter((relative) => relative && !relative.startsWith('..'));
  const workspaceBefore = discovery.authoritativeRoot
    ? null
    : snapshotWorkspaceFiles(workspace, { ...options, excludedRelativeDirs });
  let failure: string | null = discovery.coverage === 'complete' ? null : discovery.reason ?? null;

  return {
    observe(): WorkspaceDeltaObservation {
      const sources = new Set<WorkspaceObservationSource>();
      const reasons = new Set<string>();
      let coverage: WorkspaceObservationCoverage = discovery.coverage;
      if (discovery.reason) reasons.add(discovery.reason);
      const groups: LoopFileChange[][] = [];

      for (const { root, baseline } of repoBaselines) {
        const comparison = compareLoopRepoState(root, baseline);
        sources.add(discovery.authoritativeRoot ? 'workspace-git' : 'nested-git');
        if (comparison.source !== 'git') {
          coverage = coverage === 'failed' ? 'failed' : 'partial';
          reasons.add(
            `${comparison.failureReason ?? 'Git observation failed'} for `
            + `${path.relative(workspace, root) || '.'}`,
          );
          continue;
        }
        groups.push(comparison.changedFiles
          .map((repoPath) => toWorkspaceFileChange(workspace, root, repoPath))
          .filter((change): change is LoopFileChange => change !== null));
      }

      if (workspaceBefore) {
        sources.add('filesystem');
        const delta = snapshotWorkspaceDelta(workspaceBefore, workspace, {
          ...options,
          excludedRelativeDirs,
        });
        groups.push(delta.changes);
        if (delta.coverage === 'failed') {
          coverage = 'failed';
        } else if (delta.coverage === 'partial' && coverage === 'complete') {
          coverage = 'partial';
        }
        if (delta.reason) reasons.add(delta.reason);
      }

      const mergedChanges = mergeFileChanges(...groups);
      const omittedChangeCount = Math.max(
        0,
        mergedChanges.length - ATTEMPT_EVIDENCE_MAX_FILES,
      );
      if (omittedChangeCount > 0) {
        reasons.add(
          `${omittedChangeCount} additional changed path(s) omitted from bounded evidence`,
        );
      }
      const changes = mergedChanges.slice(0, ATTEMPT_EVIDENCE_MAX_FILES);
      const reason = [...reasons].join('; ').slice(0, 1_000);
      failure = coverage === 'complete' ? null : reason || `${coverage} workspace observation`;
      return {
        changes,
        coverage,
        sources: [...sources],
        ...(reason ? { reason } : {}),
      };
    },
    failureNote(): string | null {
      return failure;
    },
  };
}

/** Evidence for an attempt whose delta was observed (`null` delta = unknown). */
export function buildObservedAttemptEvidence(input: {
  outcome: LoopInvocationAttemptEvidence['outcome'];
  outputOrError: string;
  observation: WorkspaceDeltaObservation;
  providerThreadReusable: boolean;
  reason?: string | null;
}): LoopInvocationAttemptEvidence {
  const observation = input.observation;
  const delta = observation.changes;
  const reason = input.reason ?? observation.reason;
  return {
    outcome: input.outcome,
    outputExcerpt: input.outputOrError.slice(0, ATTEMPT_EVIDENCE_EXCERPT_CHARS),
    workspaceEffect: delta.length > 0
      ? 'writes-observed'
      : observation.coverage === 'complete'
        ? 'none-observed'
        : 'unknown',
    filesChanged: delta.slice(0, ATTEMPT_EVIDENCE_MAX_FILES),
    providerThreadReusable: input.providerThreadReusable,
    ...(reason ? { reason } : {}),
  };
}

function toWorkspaceFileChange(
  workspace: string,
  repoRoot: string,
  repoPath: string,
): LoopFileChange | null {
  const absolutePath = path.resolve(repoRoot, repoPath);
  const workspacePath = path.relative(workspace, absolutePath).split(path.sep).join('/');
  if (!workspacePath || workspacePath === '..' || workspacePath.startsWith('../')) return null;
  let contentHash = '';
  try {
    const stat = fs.statSync(absolutePath);
    if (stat.isFile()) {
      contentHash = stat.size <= 5 * 1024 * 1024
        ? createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex').slice(0, 16)
        : createHash('sha256')
            .update(`${stat.size}:${Math.trunc(stat.mtimeMs)}`)
            .digest('hex')
            .slice(0, 16);
    }
  } catch {
    // Deleted/unreadable paths retain an empty current-content hash.
  }
  return {
    path: workspacePath,
    additions: 0,
    deletions: contentHash ? 0 : 1,
    contentHash,
  };
}
