import type {
  LoopErrorRecord,
  LoopFileChange,
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

export const COST_PER_M_TOKENS_CENTS = 1500;
export const DEFAULT_ITERATION_TIMEOUT_MS = 30 * 60 * 1000;
export const LOOP_BREAKER_OPEN_BACKOFF_MS = 65 * 1000;
export const LOOP_MAX_BREAKER_OPEN_WAITS = 3;

export interface LoopChildResult {
  childInstanceId: string | null;
  output: string;
  tokens: number;
  costUsd?: number;
  filesChanged: LoopFileChange[];
  toolCalls: LoopToolCallRecord[];
  errors: LoopErrorRecord[];
  testPassCount: number | null;
  testFailCount: number | null;
  exitedCleanly: boolean;
  contextCompacted?: { previousUtilization: number; newUtilization: number; reason: string };
  /** A3: adapter-layer degraded classification, when the feature flag was on. */
  degradedReason?: DegradedReason;
}

export interface PauseGate {
  resolve: () => void;
}

export interface IterationHookContext {
  state: LoopState;
  iteration: LoopIteration;
}

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
  source: 'quota' | 'notice';
  action: QuotaThrottleDecision['action'] | 'notice';
  windowId?: string;
}

export type ProviderLimitResumeScheduler = (
  request: ProviderLimitResumeScheduleRequest,
) => (() => void) | void;

export interface LoopRuntimeContext {
  existingSessionContext?: string;
  priorObservations?: string[];
}
