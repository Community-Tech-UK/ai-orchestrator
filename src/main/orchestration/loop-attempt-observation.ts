/**
 * WS5 (loop-convergence plan) — invoker-side workspace-effect observation.
 *
 * Captures the before-snapshot when an attempt starts and observes the delta
 * on BOTH the success and error paths (try/finally shape), so a thrown or
 * timed-out attempt still reports what it did to the workspace. An observer
 * failure yields `null` (evidence: `unknown`) — never a claimed-clean delta.
 */

import type { LoopFileChange } from '../../shared/types/loop-state.types';
import {
  ATTEMPT_EVIDENCE_EXCERPT_CHARS,
  ATTEMPT_EVIDENCE_MAX_FILES,
  type LoopInvocationAttemptEvidence,
} from './loop-invocation-attempt';
import {
  diffFileChangeSnapshots,
  mergeFileChanges,
  snapshotFileChangesViaGit,
  snapshotFileChangesViaWorkspace,
  snapshotWorkspaceFiles,
} from './loop-workspace-snapshot';

export interface AttemptDeltaObserver {
  /** Observed delta since the before-snapshot, or null when unprovable. */
  observe(): LoopFileChange[] | null;
  /** The observer-failure note, when any capture step failed. */
  failureNote(): string | null;
}

/** Capture the before-snapshots now; failures are recorded, never thrown. */
export function createAttemptDeltaObserver(workspaceDir: string): AttemptDeltaObserver {
  let workspaceBefore: ReturnType<typeof snapshotWorkspaceFiles> | null = null;
  let gitBefore: ReturnType<typeof snapshotFileChangesViaGit> | null = null;
  let failure: string | null = null;
  try {
    workspaceBefore = snapshotWorkspaceFiles(workspaceDir);
    gitBefore = snapshotFileChangesViaGit(workspaceDir);
  } catch (err) {
    failure = `workspace snapshot failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return {
    observe(): LoopFileChange[] | null {
      if (failure || !workspaceBefore || !gitBefore) return null;
      try {
        return mergeFileChanges(
          snapshotFileChangesViaWorkspace(workspaceBefore, workspaceDir),
          diffFileChangeSnapshots(gitBefore, snapshotFileChangesViaGit(workspaceDir)),
        );
      } catch (err) {
        failure = `workspace delta observation failed: ${err instanceof Error ? err.message : String(err)}`;
        return null;
      }
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
  observedDelta: LoopFileChange[] | null;
  providerThreadReusable: boolean;
  reason?: string | null;
}): LoopInvocationAttemptEvidence {
  const delta = input.observedDelta;
  return {
    outcome: input.outcome,
    outputExcerpt: input.outputOrError.slice(0, ATTEMPT_EVIDENCE_EXCERPT_CHARS),
    workspaceEffect: delta === null
      ? 'unknown'
      : (delta.length > 0 ? 'writes-observed' : 'none-observed'),
    filesChanged: (delta ?? []).slice(0, ATTEMPT_EVIDENCE_MAX_FILES),
    providerThreadReusable: input.providerThreadReusable,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}
