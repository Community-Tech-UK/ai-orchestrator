import type {
  LoopErrorRecord,
  LoopFileChange,
  LoopInFlightIteration,
  LoopIteration,
  LoopState,
  LoopTerminalIntent,
  LoopToolCallRecord,
} from '../../shared/types/loop.types';
import type {
  ProviderId,
} from '../../shared/types/provider-quota.types';
import type { QuotaThrottleDecision } from './loop-quota-throttle';
import type { DegradedReason } from '../cli/adapters/degraded-output-classifier';
import type { LoopInvocationAttemptEvidence } from './loop-invocation-attempt';

/**
 * @deprecated Flat $15 per 1M tokens. This was applied to a token total that
 * *includes cache reads*, which bill at ~10% of the input rate — so it
 * overstated real loop spend by roughly 2.75x against the measured blended
 * rate. Iteration cost now routes through `computeTokenCost` (the single
 * source of truth in `src/shared/data/model-pricing.ts`), which prices
 * input/output/cache-read/cache-write per model.
 *
 * Retained only so historical rows can be identified and re-priced: a stored
 * `cost_cents` that exactly equals `ceil(tokens / 1e6 * 1500)` was produced by
 * this estimator and is not trustworthy.
 */
export const COST_PER_M_TOKENS_CENTS = 1500;
export const DEFAULT_ITERATION_TIMEOUT_MS = 30 * 60 * 1000;
export const LOOP_BREAKER_OPEN_BACKOFF_MS = 65 * 1000;
export const LOOP_MAX_BREAKER_OPEN_WAITS = 3;

/**
 * Per-iteration token usage as reported by the adapter. Mirrors
 * `TokenCostInput` in `src/shared/data/model-pricing.ts` so it can be handed
 * straight to `computeTokenCost` when the provider reports no dollar cost.
 */
export interface LoopChildUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface LoopChildResult {
  childInstanceId: string | null;
  output: string;
  tokens: number;
  costUsd?: number;
  /**
   * Full usage breakdown, when the adapter reported one. Required to price an
   * iteration correctly: `tokens` alone cannot distinguish a cache read (~10%
   * of input rate) from a cache write (full input rate).
   */
  usage?: LoopChildUsage;
  /** Resolved model, needed to look up the per-model rate. */
  model?: string;
  filesChanged: LoopFileChange[];
  filesRead?: string[];
  toolCalls: LoopToolCallRecord[];
  errors: LoopErrorRecord[];
  testPassCount: number | null;
  testFailCount: number | null;
  finishReason?: string;
  unresolvedToolCalls?: boolean;
  exitedCleanly: boolean;
  contextCompacted?: { previousUtilization: number; newUtilization: number; reason: string };
  /** A3: adapter-layer degraded classification, when the feature flag was on. */
  degradedReason?: DegradedReason;
  /**
   * True when this iteration ran in the chat's borrowed live adapter, so its
   * assistant stream already landed in the chat/instance transcript "as a
   * normal turn would". The iteration→ledger write (close-the-loop-write-gap)
   * skips these to avoid double-recording the same turn.
   */
  transcriptBound?: boolean;
  /** WS5: workspace-effect evidence for this attempt (side-effect-aware retry). */
  attemptEvidence?: LoopInvocationAttemptEvidence;
}

export interface LoopChildInvocationError {
  error: string;
  status?: number;
  statusCode?: number;
  code?: string | number;
  headers?: Record<string, string | readonly string[] | undefined>;
  body?: unknown;
  provider?: string;
  model?: string;
  instanceId?: string;
  /** WS5: workspace-effect evidence for the failed attempt (side-effect-aware retry). */
  attemptEvidence?: LoopInvocationAttemptEvidence;
}

export type LoopChildInvocationCallbackResult = LoopChildResult | LoopChildInvocationError;

export interface PauseGate {
  resolve: () => void;
}

export interface IterationHookContext {
  state: LoopState;
  iteration: LoopIteration;
}

export interface PreIterationHookContext {
  state: LoopState;
  inFlightIteration: LoopInFlightIteration;
}

export type LoopPreIterationHook = (ctx: PreIterationHookContext) => Promise<void> | void;
export type LoopIterationHook = (ctx: IterationHookContext) => Promise<void> | void;
export type LoopIntentPersistHook = (intent: LoopTerminalIntent) => Promise<void> | void;
export type LoopAdapterCleanupHook = (loopRunId: string) => Promise<void>;

export interface ProviderLimitResumeScheduleRequest {
  loopRunId: string;
  chatId: string;
  workspaceCwd: string;
  provider: ProviderId;
  resumeAt: number;
  reason: string;
  source: 'quota' | 'notice' | 'wakeup';
  action: QuotaThrottleDecision['action'] | 'notice' | 'wakeup';
  windowId?: string;
}

export type ProviderLimitResumeScheduler = (
  request: ProviderLimitResumeScheduleRequest,
) => (() => void) | void;

export interface LoopRuntimeContext {
  existingSessionContext?: string;
  priorObservations?: string[];
  /** Fable WS6: bounded PLAN-stage prior-context block (advisory, untrusted). */
  planStageContext?: string;
}
