/**
 * Every prompt surface that is logged by `logPromptInjection` and has a ceiling in the budget table of
 * `context/prompt-budgets.spec.ts`. That spec checks each name here is a key of the table, so a size seen in
 * a log can always be compared with its ceiling. Advisory system-prompt blocks are the other kind of surface;
 * their ceilings are `ADVISORY_CHAR_BUDGETS` in `context/budgeted-system-prompt.ts`.
 */
export const PROMPT_SURFACES = [
  'child', 'childWindows',
  'loopFirst', 'loopContinuation', 'loopReanchor',
  'reviewLoopFirst', 'reviewLoopContinuation', 'reviewLoopReanchor',
  'queueWorker', 'queueLivetestWorker', 'queueResume', 'queueResumeConflict',
  'queueContinue', 'queueContinueConflict', 'queueStepUp', 'queueLivetestStepUp',
  'queueFix', 'queueConflict', 'queueGateFailure', 'queueActiveDocuments', 'queueWorkerReminder', 'queueWorkerRetry', 'queueVerifierReminder',
  'queueVerifier', 'queueLivetestVerifier', 'queueTriage',
  'structuredReview', 'tieredReview', 'structuredRepair', 'tieredRepair',
  'pingPongReview', 'pingPongRepair',
  'localStructuredReview', 'localTieredReview', 'localReviewRepair',
  'codexStandingNotes', 'rtk', 'summaryHelper', 'subqueryHelper', 'titleSystem', 'titleRequest',
] as const;

export type PromptSurface = typeof PROMPT_SURFACES[number];
