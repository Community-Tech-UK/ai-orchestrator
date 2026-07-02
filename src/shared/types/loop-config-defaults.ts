/**
 * Default `LoopConfig` factory, extracted from `loop.types.ts` (audit-fixes
 * plan Fix 6: LOC-ratchet headroom — opportunistic extraction on touch).
 * Re-exported from `loop.types.ts`, so import sites are unchanged.
 *
 * Note: this module and `loop.types.ts` form a benign import cycle — every
 * cross-module value is dereferenced at call time (inside `defaultLoopConfig`),
 * never at module-evaluation time.
 */

import type { LoopConfig } from './loop.types';
import {
  DEFAULT_LOOP_MAX_COST_CENTS,
  DEFAULT_LOOP_MAX_ITERATIONS,
  DEFAULT_LOOP_MAX_TOKENS,
  DEFAULT_LOOP_MAX_WALL_TIME_MS,
  LOOP_DEFAULT_MAX_TURNS_PER_ITERATION,
  defaultLoopContextConfig,
  defaultLoopExplorationConfig,
  defaultLoopPlanConfig,
  defaultNextObjectivePlanningConfig,
  defaultSemanticProgressConfig,
} from './loop.types';
import { defaultLoopAuditConfig } from './loop-audit.types';

/** Default config factory. */
export function defaultLoopConfig(workspaceCwd: string, initialPrompt: string): LoopConfig {
  return {
    initialPrompt,
    // Default to undefined so legacy single-prompt loops keep their existing
    // behaviour (initialPrompt used on every iteration). The renderer fills
    // this in when the user types both a textarea goal and a panel directive.
    iterationPrompt: undefined,
    workspaceCwd,
    provider: 'claude',
    reviewStyle: 'debate',
    contextStrategy: 'same-session',
    maxTurnsPerIteration: LOOP_DEFAULT_MAX_TURNS_PER_ITERATION,
    caps: {
      maxIterations: DEFAULT_LOOP_MAX_ITERATIONS,
      maxWallTimeMs: DEFAULT_LOOP_MAX_WALL_TIME_MS,
      maxTokens: DEFAULT_LOOP_MAX_TOKENS,
      maxCostCents: DEFAULT_LOOP_MAX_COST_CENTS,
      maxToolCallsPerIteration: 200,
      maxCompletionAttempts: 3,
      // D2 (#6 interim): end capped runs with a structured hand-off iteration.
      capWrapUpIteration: true,
    },
    progressThresholds: {
      identicalHashWarnConsecutive: 2,
      identicalHashCriticalConsecutive: 3,
      identicalHashCriticalWindow: 3,
      similarityWarnMean: 0.85,
      similarityCriticalMean: 0.92,
      stageWarnIterations: { PLAN: 3, REVIEW: 2, IMPLEMENT: 8 },
      stageCriticalIterations: { PLAN: 5, REVIEW: 3, IMPLEMENT: 12 },
      errorRepeatWarnInWindow: 3,
      errorRepeatCriticalInWindow: 4,
      tokensWithoutProgressWarn: 25_000,
      tokensWithoutProgressCritical: 60_000,
      // Default OFF: too many real tasks spend tokens without moving the
      // test pass count, and the user shouldn't have to babysit the loop.
      // Renderer panel exposes a checkbox to opt-in for tests-driven flows.
      pauseOnTokenBurn: false,
      toolRepeatWarnPerIteration: 5,
      toolRepeatCriticalPerIteration: 8,
      identicalToolCallConsecutiveCritical: 3,
      idempotentReadRepeatWarn: 3,
      testStagnationWarnIterations: 3,
      testStagnationCriticalIterations: 5,
      churnRatioWarn: 0.30,
      churnRatioCritical: 0.50,
      warnEscalationWindow: 5,
      warnEscalationCount: 3,
    },
    semanticProgress: defaultSemanticProgressConfig(),
    context: defaultLoopContextConfig(),
    exploration: defaultLoopExplorationConfig(),
    plan: defaultLoopPlanConfig(),
    audit: defaultLoopAuditConfig(),
    nextObjectivePlanning: defaultNextObjectivePlanningConfig(),
    blockSanityProbe: { enabled: true, timeoutMs: 5000 },
    degradedIterationRetry: { enabled: true, maxRetries: 2 },
    completion: {
      // Engine default is the legacy gated ladder so the test suite and
      // programmatic callers are unaffected; `prepareLoopStartConfig` upgrades
      // user-started loops to 'review-driven'.
      mode: 'gated',
      requiredCleanReviewPasses: 2,
      noOutstandingPhrase: 'There are no outstanding issues',
      maxStalledReviewIterations: 3,
      maxLedgerStallIterations: 8,
      completedFilenamePattern: '*_[Cc]ompleted.md',
      donePromiseRegex: '<promise>\\s*DONE\\s*</promise>',
      doneSentinelFile: 'DONE.txt',
      verifyCommand: '',
      allowOperatorReviewedCompletion: false,
      verifyTimeoutMs: 600_000,
      // FU-6 quick-verify defaults: undefined command means the optimization
      // is opt-in. A 2-minute timeout reflects "should be fast or it isn't
      // a quick verify". Callers wanting the split set both fields.
      quickVerifyCommand: undefined,
      quickVerifyTimeoutMs: 120_000,
      runVerifyTwice: true,
      requireCompletedFileRename: false,
      // F2 (#22): coordinator-enforced REVIEW→PLAN back-edge cap. 0 disables.
      maxReviewCycles: 10,
      // D6 (#7): anti-self-grading hardening is opt-in (⚠️HOT completion gating).
      antiSelfGrading: false,
    },
    allowDestructiveOps: false,
    initialStage: 'IMPLEMENT',
    goalIntent: 'implementation',
    iterationTimeoutMs: undefined,
    streamIdleTimeoutMs: undefined,
  };
}
