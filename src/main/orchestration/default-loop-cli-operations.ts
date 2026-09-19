/**
 * Parent-process implementation of the `aio-mcp loop` operations.
 *
 * Lives beside the coordinator rather than in `src/main/mcp/` so the SEA
 * bundle's dispatch layer keeps importing only the contracts module — the
 * coordinator pulls in Electron and better-sqlite3, neither of which may
 * reach the `aio-mcp` binary.
 */

import { getLogger } from '../logging/logger';
import type {
  LoopCliListPayload,
  LoopCliListResult,
  LoopCliOperations,
  LoopCliResumePayload,
  LoopCliResumeResult,
  LoopCliRun,
} from '../mcp/loop-cli-contracts';
import { LOOP_CLI_GOAL_PREVIEW_CHARS } from '../mcp/loop-cli-contracts';
import { getLoopCoordinator } from './loop-coordinator';
import { getLoopStore } from './loop-store';
import {
  resumeLoopRun,
  type LoopResumeCoordinator,
  type LoopResumeStore,
} from './loop-resume';
import { isParkedLoopRuntimeState } from './loop-runtime-status';
import type { LoopRunSummary, LoopState } from '../../shared/types/loop.types';

const logger = getLogger('LoopCliOperations');

/** `LoopStore.listRuns` documents 200 as the largest window callers may ask for. */
const LOOP_LIST_SCAN_LIMIT = 200;

export interface LoopCliOperationsDeps {
  getCoordinator: () => LoopResumeCoordinator & { getActiveLoops(): LoopState[] };
  getStore: () => LoopResumeStore & { listRuns(limit?: number): LoopRunSummary[] };
}

export function createLoopCliOperations(deps: LoopCliOperationsDeps): LoopCliOperations {
  return {
    list(payload: LoopCliListPayload): LoopCliListResult {
      const coordinator = deps.getCoordinator();
      const store = deps.getStore();
      const liveIds = new Set(coordinator.getActiveLoops().map((state) => state.id));
      // When filtering, scan the whole window the store allows so a resumable
      // loop is not pushed out by newer terminal runs, then trim to the limit.
      const scanLimit = payload.all ? payload.limit : LOOP_LIST_SCAN_LIMIT;
      const runs = store.listRuns(scanLimit)
        .map((run) => toCliRun(run, liveIds.has(run.id), store))
        .filter((run) => payload.all || run.resumable)
        .slice(0, payload.limit);
      return { count: runs.length, runs };
    },

    async resume(payload: LoopCliResumePayload): Promise<LoopCliResumeResult> {
      const coordinator = deps.getCoordinator();
      const store = deps.getStore();
      const previousStatus = coordinator.getLoop(payload.loopRunId)?.status
        ?? storedStatus(store, payload.loopRunId);
      const outcome = await resumeLoopRun(coordinator, store, payload.loopRunId);
      if (!outcome.ok || !outcome.state) {
        throw new Error(outcome.reason ?? `Loop ${payload.loopRunId} could not be resumed.`);
      }
      logger.info('Loop resumed via aio-mcp loop CLI', {
        loopRunId: payload.loopRunId,
        previousStatus,
        restoredFromCheckpoint: outcome.restoredFromCheckpoint,
      });
      return {
        loopRunId: payload.loopRunId,
        resumed: true,
        status: outcome.state.status,
        previousStatus: previousStatus ?? outcome.state.status,
        restoredFromCheckpoint: outcome.restoredFromCheckpoint,
      };
    },
  };
}

export function createDefaultLoopCliOperations(): LoopCliOperations {
  return createLoopCliOperations({
    getCoordinator: getLoopCoordinator,
    getStore: getLoopStore,
  });
}

function toCliRun(
  run: LoopRunSummary,
  live: boolean,
  store: LoopResumeStore,
): LoopCliRun {
  const statusResumable = isParkedLoopRuntimeState(run);
  // Only pay for a checkpoint lookup when the status could actually resume.
  const checkpointAvailable = statusResumable && store.getCheckpoint(run.id) !== null;
  return {
    loopRunId: run.id,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    endReason: run.endReason,
    totalIterations: run.totalIterations,
    workspaceCwd: run.workspaceCwd,
    goal: truncateGoal(run.initialPrompt),
    live,
    checkpointAvailable,
    resumable: statusResumable && (live || checkpointAvailable),
  };
}

function truncateGoal(initialPrompt: string): string {
  const collapsed = initialPrompt.replace(/\s+/g, ' ').trim();
  return collapsed.length > LOOP_CLI_GOAL_PREVIEW_CHARS
    ? `${collapsed.slice(0, LOOP_CLI_GOAL_PREVIEW_CHARS - 1)}…`
    : collapsed;
}

function storedStatus(
  store: LoopResumeStore,
  loopRunId: string,
): LoopState['status'] | undefined {
  return store.getCheckpoint(loopRunId)?.status;
}
