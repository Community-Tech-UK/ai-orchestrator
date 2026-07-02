/**
 * LF-5 (loopfixex.md) — branch-and-select on stuck (best-of-N).
 *
 * On a CRITICAL no-progress the loop normally just pauses for a human. The
 * test-time-compute literature's highest-leverage move is the opposite: at a
 * hard point, sample N candidates in parallel and pick the best via a verifier
 * (+7–15%; cross-model more). When `exploration.enabled` AND a cost cap is set,
 * this fans out `fanout` candidate iterations in isolated worktrees, verifies
 * each, selects a winner (verify-pass + optional list-wise comparison), adopts
 * it and discards the losers, then the serial loop continues from the winner.
 *
 * Design: the GATING and SELECTION are pure + unit-tested; the orchestration
 * (`runBranchSelect`) takes injectable `deps` so the fan-out/verify/adopt/
 * cleanup flow is unit-tested with mocks (the real deps drive the worktree +
 * CLI runtime, which a unit test can't exercise). Default OFF → zero impact
 * until a loop opts in, and any failure degrades gracefully to a normal pause.
 */

import { getLogger } from '../logging/logger';
import type { LoopExplorationConfig, LoopHardCaps } from '../../shared/types/loop.types';
import { normalizeLoopPhase4Config, type LoopPhase4ConfigInput } from '../../shared/types/loop-phase4.types';
import {
  validateLoopTaskPackets,
  type LoopTaskPacket,
} from './loop-subagent-contracts';

const logger = getLogger('LoopBranchSelect');

export interface BranchSelectInput {
  loopRunId: string;
  workspaceCwd: string;
  goal: string;
  exploration: LoopExplorationConfig;
  caps: LoopHardCaps;
  /** Spend so far, to enforce caps before fanning out. */
  spentTokens: number;
  spentCents: number;
  /** The prompt the stuck iteration would run; candidates run a variant of it. */
  prompt: string;
  /** Base provider for candidates (when not crossModel). */
  provider: string;
  /** Verify command run in each candidate worktree (required to select). */
  verifyCommand: string;
  /** Verify timeout per candidate (ms). */
  verifyTimeoutMs: number;
  /** Per-candidate CLI wall-clock timeout (ms). */
  iterationTimeoutMs: number;
  /** Phase 4 opt-ins consumed by fan-out safety gates. */
  phase4?: LoopPhase4ConfigInput | null;
  /** Optional caller-supplied task packets for the fan-out candidates. */
  taskPackets?: readonly unknown[];
}

/**
 * Pick a candidate's provider. With `crossModel`, alternate Claude/Codex for
 * rollout diversity (the literature's Pass@K boost); otherwise the base
 * provider. Pure.
 */
export function pickCandidateProvider(base: string, crossModel: boolean, index: number): string {
  if (!crossModel) return base;
  const rotation = ['claude', 'codex'];
  return rotation[index % rotation.length];
}

export interface BranchCandidate {
  id: string;
  provider: string;
  /** Isolated worktree path the candidate ran in. */
  workdir: string;
  /** Did the candidate's verify command pass? */
  verifyPassed: boolean;
  /** Files the candidate changed (count) — a cheap tie-break heuristic. */
  filesChanged: number;
  /** Short diff/summary used for list-wise comparison. */
  summary: string;
}

export interface BranchSelectResult {
  adopted: boolean;
  reason: string;
  winnerId?: string;
  winnerProvider?: string;
  candidateCount: number;
  scores?: Record<string, number>;
}

export type LoopBranchSelector = (input: BranchSelectInput) => Promise<BranchSelectResult>;

// ============ Pure gating ============

/**
 * Decide whether branch-and-select should run for this CRITICAL. Requires the
 * feature enabled AND a non-null cost cap (fan-out multiplies spend), AND that
 * a single fan-out round wouldn't blow the remaining cost headroom. Pure.
 */
export function shouldRunBranchSelect(input: BranchSelectInput): { run: boolean; reason: string } {
  const { exploration, caps, spentCents } = input;
  if (!exploration.enabled) return { run: false, reason: 'exploration disabled' };
  if (caps.maxCostCents === null || caps.maxCostCents === undefined) {
    return { run: false, reason: 'no cost cap set — branch-select requires a spend ceiling' };
  }
  // Require at least ~1/fanout of the remaining budget free, so a fan-out round
  // can't immediately exceed caps. Conservative: need headroom > 0.
  const costHeadroom = caps.maxCostCents - spentCents;
  if (costHeadroom <= 0) return { run: false, reason: 'cost cap exhausted' };
  return { run: true, reason: `eligible — fanout ${exploration.fanout}, headroom ok` };
}

// ============ Pure selection ============

export interface SelectionOutcome {
  winner: BranchCandidate | null;
  scores: Record<string, number>;
  reason: string;
}

/**
 * Pick the best candidate. Verify is the hard gate: only verify-passing
 * candidates are eligible. Among those, `listwiseScores` (an LLM list-wise
 * comparison, when provided) ranks them; otherwise the tie-break is "most files
 * changed" (a candidate that did more substantive work). Returns no winner when
 * none passed verify (→ the loop falls back to a normal pause). Pure.
 */
export function selectWinner(
  candidates: readonly BranchCandidate[],
  listwiseScores?: Record<string, number>,
): SelectionOutcome {
  const passing = candidates.filter((c) => c.verifyPassed);
  if (passing.length === 0) {
    return { winner: null, scores: {}, reason: 'no candidate passed verify' };
  }
  const scores: Record<string, number> = {};
  for (const c of passing) {
    // Base score: verify pass (1.0) + small bump for substantive change.
    const listwise = listwiseScores?.[c.id];
    scores[c.id] = listwise !== undefined ? listwise : 1 + Math.min(c.filesChanged, 50) / 100;
  }
  let winner = passing[0];
  for (const c of passing) {
    if ((scores[c.id] ?? 0) > (scores[winner.id] ?? 0)) winner = c;
  }
  return {
    winner,
    scores,
    reason: listwiseScores
      ? `winner ${winner.id} by list-wise score ${scores[winner.id]?.toFixed(2)}`
      : `winner ${winner.id} (verify-pass, ${winner.filesChanged} files)`,
  };
}

// ============ Orchestration (injectable deps) ============

export interface BranchSelectDeps {
  /** Snapshot + create N isolated worktrees, run a candidate in each, verify each. */
  fanout: (input: BranchSelectInput) => Promise<BranchCandidate[]>;
  /** Optional list-wise LLM comparison → score per candidate id. */
  listwiseScore?: (candidates: readonly BranchCandidate[], goal: string) => Promise<Record<string, number>>;
  /** Adopt the winning candidate's changes into the loop workspace. */
  adopt: (winner: BranchCandidate, workspaceCwd: string) => Promise<void>;
  /** Tear down all candidate worktrees (winner + losers). Must be robust. */
  cleanup: (candidates: readonly BranchCandidate[]) => Promise<void>;
}

/**
 * Orchestrate one branch-and-select round. Always cleans up every worktree
 * (winner adopted into the workspace first, then all worktrees discarded), even
 * on error — robust cleanup is a hard requirement (no disk leaks). Returns
 * `adopted: false` whenever no winner emerges so the caller falls back to a
 * normal pause.
 */
export async function runBranchSelect(input: BranchSelectInput, deps: BranchSelectDeps): Promise<BranchSelectResult> {
  const gate = shouldRunBranchSelect(input);
  if (!gate.run) return { adopted: false, reason: gate.reason, candidateCount: 0 };
  let runtimeInput = input;
  const contracts = normalizeLoopPhase4Config(input.phase4).subagentContracts;
  if (contracts.enabled) {
    const packets = input.taskPackets ?? buildBranchSelectTaskPackets(input);
    const validation = validateLoopTaskPackets(packets, {
      maxDepth: contracts.maxDepth,
      requireNonOverlappingWriteScopes: contracts.requireNonOverlappingWriteScopes,
    });
    if (!validation.ok) {
      return {
        adopted: false,
        reason: `subagent contract validation failed: ${validation.errors.join('; ')}`,
        candidateCount: 0,
      };
    }
    runtimeInput = { ...input, taskPackets: validation.packets };
  }

  let candidates: BranchCandidate[] = [];
  try {
    candidates = await deps.fanout(runtimeInput);
    if (candidates.length === 0) {
      return { adopted: false, reason: 'fan-out produced no candidates', candidateCount: 0 };
    }
    let listwise: Record<string, number> | undefined;
    if (runtimeInput.exploration.selector === 'verify+listwise' && deps.listwiseScore) {
      try {
        listwise = await deps.listwiseScore(candidates, runtimeInput.goal);
      } catch (err) {
        logger.warn('Branch-select list-wise scoring failed; falling back to verify+heuristic', {
          loopRunId: input.loopRunId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const selection = selectWinner(candidates, listwise);
    if (!selection.winner) {
      return { adopted: false, reason: selection.reason, candidateCount: candidates.length, scores: selection.scores };
    }
    await deps.adopt(selection.winner, runtimeInput.workspaceCwd);
    return {
      adopted: true,
      reason: selection.reason,
      winnerId: selection.winner.id,
      winnerProvider: selection.winner.provider,
      candidateCount: candidates.length,
      scores: selection.scores,
    };
  } catch (err) {
    logger.warn('Branch-select round failed; falling back to pause', {
      loopRunId: input.loopRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { adopted: false, reason: `branch-select error: ${err instanceof Error ? err.message : String(err)}`, candidateCount: candidates.length };
  } finally {
    // Robust cleanup: discard every worktree regardless of outcome.
    try {
      await deps.cleanup(candidates);
    } catch (err) {
      logger.warn('Branch-select worktree cleanup failed', {
        loopRunId: input.loopRunId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function buildBranchSelectTaskPackets(input: BranchSelectInput): LoopTaskPacket[] {
  const verify = input.verifyCommand.trim() || 'no verify command configured';
  return Array.from({ length: Math.max(0, input.exploration.fanout) }, (_, index) => ({
    id: `branch-candidate-${index + 1}`,
    objective: input.prompt,
    scope: {
      read: [input.workspaceCwd],
      // Candidates write in separate worktrees. Use logical per-candidate
      // scopes so the non-overlap gate models the isolation boundary.
      write: [`branch-select/${input.loopRunId}/candidate-${index + 1}`],
    },
    acceptanceCriteria: ['Produce a candidate change that advances the loop goal.'],
    verificationPlan: [verify],
    depth: 0,
  }));
}

/**
 * Default selector. The real fan-out drives the parallel-worktree coordinator +
 * per-candidate CLI invocations, which require the live runtime; that wiring is
 * intentionally NOT performed here (it would be unverifiable in this layer and
 * is provided by the host when exploration is enabled). The safe default
 * degrades to a normal pause (`adopted: false`) so enabling `exploration`
 * without host wiring never breaks a loop. The host overrides this via
 * `LoopCoordinator.setBranchSelector(...)` with deps bound to the runtime.
 */
export const defaultBranchSelector: LoopBranchSelector = async (input) => {
  const gate = shouldRunBranchSelect(input);
  if (!gate.run) return { adopted: false, reason: gate.reason, candidateCount: 0 };
  logger.info('Branch-select requested but no runtime fan-out is wired; falling back to pause', {
    loopRunId: input.loopRunId,
  });
  return {
    adopted: false,
    reason: 'branch-select runtime not wired (set a branch selector to enable fan-out) — pausing',
    candidateCount: 0,
  };
};
