// Defaults that match defaultLoopConfig() in src/shared/types/loop.types.ts.
// We must include all sub-fields whenever caps/completion/progressThresholds
// are sent — those strict blocks fail validation if they are present but empty.
export const DEFAULT_CAPS = {
  maxIterations: 50,
};
/** WS6: finite per-iteration turn default (mirrors
 *  LOOP_DEFAULT_MAX_TURNS_PER_ITERATION = 30 in shared loop types). */
export const DEFAULT_MAX_TURNS_PER_ITERATION = 30;
/** Lower bound for the optional token cap. Below this a single substantial
 *  iteration (file reads + a long turn) would trip it instantly, which is the
 *  exact foot-gun the old hidden 1M default caused on 1M-context models. */
export const MIN_MAX_TOKENS = 10_000;
export const MAX_MAX_TOKENS = 100_000_000;
export const DEFAULT_MAX_WALL_TIME_HOURS = 50;
export const MAX_WALL_TIME_HOURS = 7 * 24;
export const DEFAULT_COMPLETION = {
  completedFilenamePattern: '*_[Cc]ompleted.md',
  donePromiseRegex: '<promise>\\s*DONE\\s*</promise>',
  doneSentinelFile: 'DONE.txt',
  verifyTimeoutMs: 1_200_000,
  quickVerifyTimeoutMs: 120_000,
};
/** Mirrors defaultLoopConfig().progressThresholds. We only ever ship this
 *  to the main process when the user opts into a non-default progress toggle,
 *  because Zod requires the full strict
 *  shape if the field is present at all. */
export const DEFAULT_PROGRESS_THRESHOLDS = {
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
};
export const DEFAULT_SEMANTIC_PROGRESS = {
  cadence: 5,
  confidenceFloor: 0.6,
};
export const DEFAULT_EXPLORATION = {
  fanout: 3,
  crossModel: false as const,
  selector: 'verify+listwise' as const,
};
export const DEFAULT_NEXT_OBJECTIVE_PLANNING = {
  cadence: 1,
};
export const DEFAULT_AUDIT = {
  finalAuditMode: 'observe' as const,
  preflightMode: 'record' as const,
  planPacketMode: 'off' as const,
  cleanlinessScan: true,
};
export type PlanPacketMode = 'off' | 'prompted';
