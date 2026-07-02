import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getLogger } from '../logging/logger';
import { gitExec } from '../workspace/git/git-exec';
import { getGitWriteQueue } from '../workspace/git/git-write-queue';
import type { LoopIteration } from '../../shared/types/loop.types';
import {
  normalizeLoopPhase4Config,
  type LoopCommitRatchetConfig,
} from '../../shared/types/loop-phase4.types';
import type { LoopIterationHook } from './loop-coordinator.types';

const logger = getLogger('LoopCommitRatchet');

export type LoopCommitRatchetRuntimeConfig = LoopCommitRatchetConfig;

export type LoopCommitRatchetResult =
  | { status: 'disabled' }
  | { status: 'refused'; reason: string }
  | { status: 'kept'; candidateCommit: string }
  | { status: 'reset'; candidateCommit: string; resetTo: string };

export interface LoopCommitRatchetInput {
  loopRunId: string;
  workspaceCwd: string;
  executionCwd?: string;
  lastKeptCommit?: string;
  previousScore: number;
  candidateScore: number;
  message: string;
  config?: Partial<LoopCommitRatchetRuntimeConfig>;
}

export interface LoopCommitRatchetHookDeps {
  run?: (input: LoopCommitRatchetInput) => Promise<LoopCommitRatchetResult>;
}

interface RatchetTracker {
  lastKeptCommit?: string;
  previousScore: number;
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function isLinkedWorktreeForWorkspace(executionCwd: string, workspaceCwd: string): Promise<boolean> {
  try {
    const [executionGitDir, executionCommonDir, workspaceCommonDir] = await Promise.all([
      gitExec(['rev-parse', '--absolute-git-dir'], executionCwd),
      gitExec(['rev-parse', '--path-format=absolute', '--git-common-dir'], executionCwd),
      gitExec(['rev-parse', '--path-format=absolute', '--git-common-dir'], workspaceCwd),
    ]);
    const [execGit, execCommon, workspaceCommon] = await Promise.all([
      canonicalPath(executionGitDir),
      canonicalPath(executionCommonDir),
      canonicalPath(workspaceCommonDir),
    ]);
    return execGit !== execCommon && execCommon === workspaceCommon;
  } catch {
    return false;
  }
}

function ratchetConfig(input?: Partial<LoopCommitRatchetRuntimeConfig>): LoopCommitRatchetRuntimeConfig {
  return normalizeLoopPhase4Config({ commitRatchet: input }).commitRatchet;
}

async function ensureCandidateCommit(cwd: string, message: string): Promise<string> {
  const status = await gitExec(['status', '--porcelain'], cwd);
  if (status.trim()) {
    await gitExec(['add', '-A'], cwd);
    await gitExec(['commit', '-q', '--no-gpg-sign', '-m', message], cwd, 120_000);
  }
  return gitExec(['rev-parse', 'HEAD'], cwd);
}

async function assertCleanHead(cwd: string, expectedCommit: string, label: string): Promise<void> {
  const [head, status] = await Promise.all([
    gitExec(['rev-parse', 'HEAD'], cwd),
    gitExec(['status', '--porcelain'], cwd),
  ]);
  if (head.trim() !== expectedCommit.trim()) {
    throw new Error(`commit ratchet ${label} mismatch: HEAD ${head.trim()} !== expected ${expectedCommit.trim()}`);
  }
  if (status.trim()) {
    throw new Error(`commit ratchet ${label} left a dirty worktree`);
  }
}

export async function runLoopCommitRatchet(
  input: LoopCommitRatchetInput,
): Promise<LoopCommitRatchetResult> {
  const config = ratchetConfig(input.config);
  if (!config.enabled) return { status: 'disabled' };

  const executionCwd = input.executionCwd;
  if (
    config.worktreeOnly &&
    (!executionCwd ||
      samePath(executionCwd, input.workspaceCwd) ||
      !(await isLinkedWorktreeForWorkspace(executionCwd, input.workspaceCwd)))
  ) {
    return {
      status: 'refused',
      reason: 'commit ratchet only runs inside a linked worktree for the loop workspace',
    };
  }

  const cwd = executionCwd ?? input.workspaceCwd;
  return getGitWriteQueue().enqueue(`loop-ratchet:${input.loopRunId}`, async () => {
    const lastKeptCommit = input.lastKeptCommit?.trim()
      || await gitExec(['rev-parse', 'HEAD'], cwd);
    const candidateCommit = await ensureCandidateCommit(cwd, input.message);
    await assertCleanHead(cwd, candidateCommit, 'candidate');

    if (input.candidateScore > input.previousScore) {
      logger.info('Loop commit ratchet kept candidate', {
        loopRunId: input.loopRunId,
        candidateCommit,
        previousScore: input.previousScore,
        candidateScore: input.candidateScore,
      });
      return { status: 'kept', candidateCommit };
    }

    if (config.resetOnRegression) {
      await gitExec(['reset', '--hard', lastKeptCommit], cwd, 120_000);
      await assertCleanHead(cwd, lastKeptCommit, 'reset');
      logger.info('Loop commit ratchet reset regressing candidate', {
        loopRunId: input.loopRunId,
        candidateCommit,
        resetTo: lastKeptCommit,
        previousScore: input.previousScore,
        candidateScore: input.candidateScore,
      });
      return { status: 'reset', candidateCommit, resetTo: lastKeptCommit };
    }

    return { status: 'kept', candidateCommit };
  });
}

export function scoreIterationForCommitRatchet(iteration: LoopIteration): number {
  const verdictScore = iteration.progressVerdict === 'OK'
    ? 3
    : iteration.progressVerdict === 'WARN'
      ? 0
      : -3;
  const verifyScore = iteration.verifyStatus === 'passed'
    ? 4
    : iteration.verifyStatus === 'failed'
      ? -4
      : 0;
  const passScore = Math.min(5, Math.max(0, iteration.testPassCount ?? 0));
  const failPenalty = Math.min(5, Math.max(0, iteration.testFailCount ?? 0));
  const changeScore = (iteration.filesChanged?.length ?? 0) > 0 ? 1 : 0;
  const errorPenalty = Math.min(6, (iteration.errors?.length ?? 0) * 2);
  const unresolvedPenalty = iteration.unresolvedToolCalls ? 3 : 0;
  return verdictScore + verifyScore + passScore + changeScore - failPenalty - errorPenalty - unresolvedPenalty;
}

export function createLoopCommitRatchetHook(deps: LoopCommitRatchetHookDeps = {}): LoopIterationHook {
  const run = deps.run ?? runLoopCommitRatchet;
  const trackers = new Map<string, RatchetTracker>();

  return async ({ state, iteration }) => {
    const phase4 = normalizeLoopPhase4Config(state.config.phase4);
    if (!phase4.commitRatchet.enabled) return;

    const tracker = trackers.get(state.id) ?? { previousScore: 0 };
    const candidateScore = scoreIterationForCommitRatchet(iteration);
    const result = await run({
      loopRunId: state.id,
      workspaceCwd: state.config.workspaceCwd,
      executionCwd: state.config.executionCwd,
      lastKeptCommit: tracker.lastKeptCommit,
      previousScore: tracker.previousScore,
      candidateScore,
      message: `loop ${state.id} iteration ${iteration.seq} ratchet`,
      config: phase4.commitRatchet,
    });

    if (result.status === 'kept') {
      trackers.set(state.id, { lastKeptCommit: result.candidateCommit, previousScore: candidateScore });
    } else if (result.status === 'reset') {
      trackers.set(state.id, tracker);
    } else if (result.status === 'refused') {
      logger.warn('Loop commit ratchet refused', { loopRunId: state.id, reason: result.reason });
    }
  };
}

export const loopCommitRatchetHook = createLoopCommitRatchetHook();
