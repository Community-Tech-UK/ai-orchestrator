import type {
  CompletionSignalId,
  LoopStage,
  LoopStatus,
  LoopTerminalIntent,
  LoopVerdict,
  ProgressSignalEvidence,
} from './loop.types';

// ============ Stream events (async generator) ============

export type LoopStreamEvent =
  | { type: 'started'; loopRunId: string; chatId: string }
  | { type: 'iteration-started'; loopRunId: string; seq: number; stage: LoopStage }
  | { type: 'activity'; event: LoopActivityEvent }
  | { type: 'iteration-complete'; loopRunId: string; seq: number; verdict: LoopVerdict }
  | { type: 'paused-no-progress'; loopRunId: string; signal: ProgressSignalEvidence }
  | { type: 'claimed-done-but-failed'; loopRunId: string; signal: CompletionSignalId; failure: string }
  | { type: 'terminal-intent-recorded'; loopRunId: string; intent: LoopTerminalIntent }
  | { type: 'terminal-intent-rejected'; loopRunId: string; intent: LoopTerminalIntent; reason: string }
  | { type: 'intervention-applied'; loopRunId: string; message: string }
  | { type: 'completed'; loopRunId: string; signal: CompletionSignalId; verifyOutput: string; acceptedByOperator?: boolean }
  /** LF-7: terminal "done, needs a human glance" - operator-accepted or budget-exhausted-but-verified. */
  | { type: 'completed-needs-review'; loopRunId: string; reason: string; acceptedByOperator: boolean }
  | { type: 'provider-limit'; loopRunId: string; reason?: string; willResume: boolean; resumeAt?: number | null }
  | { type: 'terminal-status'; loopRunId: string; status: LoopStreamTerminalStatus; reason?: string }
  | { type: 'failed'; loopRunId: string; reason: string }
  | {
      type: 'cap-reached';
      loopRunId: string;
      cap: 'iterations' | 'wall-time' | 'tokens' | 'cost' | 'completion-attempts';
      reason?: string;
    }
  | { type: 'cancelled'; loopRunId: string }
  | { type: 'error'; loopRunId: string; error: string };

export type LoopStreamTerminalStatus =
  | 'no-progress'
  | 'provider-limit'
  | 'cost-exceeded'
  | 'needs-human-arbitration'
  | 'reviewer-unreliable'
  | 'reviewer-unavailable'
  | 'builder-unreliable';

export type LoopActivityKind =
  | 'spawned'
  | 'status'
  | 'tool_use'
  | 'assistant'
  | 'system'
  | 'input_required'
  | 'error'
  | 'stream-idle'
  | 'complete'
  | 'heartbeat';

export interface LoopActivityEvent {
  loopRunId: string;
  seq: number;
  stage: LoopStage | string;
  kind: LoopActivityKind;
  message: string;
  timestamp: number;
  detail?: Record<string, unknown>;
}

// ============ Helpers ============

export interface LoopRunSummary {
  id: string;
  chatId: string;
  status: LoopStatus;
  totalIterations: number;
  totalTokens: number;
  totalCostCents: number;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  /** The goal/ask the loop was started with (iteration 0 prompt). Pulled
   *  from the persisted config so the renderer can let users copy/inspect/
   *  reattempt past prompts even after an app reload. */
  initialPrompt: string;
  /** Optional continuation directive used on iterations 1+. Null when the
   *  loop re-used `initialPrompt` for every iteration. */
  iterationPrompt: string | null;
  /** Count of still-open (un-resolved, un-dismissed) outstanding items captured
   *  from this run's OUTSTANDING.md. Omitted (undefined) when not computed. */
  openOutstandingCount?: number;
}
