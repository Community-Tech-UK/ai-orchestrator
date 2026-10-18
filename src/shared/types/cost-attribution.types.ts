/** Why Harness initiated a model call. Kept stable across logs and cost UI. */
export type ModelCallPurpose =
  | 'chat' | 'child' | 'loop' | 'verify' | 'review' | 'debate' | 'workflow' | 'branch-select'
  | 'cross-model-review' | 'fresh-eyes-review' | 'review-cli' | 'consensus'
  | 'multi-verify-synthesis' | 'council' | 'compare' | 'magic-prompt' | 'cli-verification'
  | 'helper' | 'automation' | 'channel' | 'subagent';
export type ModelCallCostSource = 'provider' | 'priced' | 'unknown' | 'free';
export type ModelCallOutcome = 'success' | 'error' | 'cancelled' | 'budget-exceeded';
