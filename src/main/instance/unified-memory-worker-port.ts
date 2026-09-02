import type {
  LearnedPattern,
  RetrievalOptions,
  SessionMemory,
  SessionOutcome,
  StrategyMemory,
  UnifiedMemoryConfig,
  UnifiedMemorySnapshot,
  UnifiedMemoryStats,
  UnifiedRetrievalResult,
  WorkflowMemory,
} from '../../shared/types/unified-memory.types';

/** Plain values that can cross the context-worker structured-clone boundary. */
export type UnifiedMemoryCloneValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | UnifiedMemoryCloneValue[]
  | { [key: string]: UnifiedMemoryCloneValue };

export type UnifiedMemoryWorkerRequest =
  | { kind: 'process-input'; input: string; sessionId: string; taskId: string }
  | { kind: 'retrieve'; query: string; taskId: string; options?: RetrievalOptions }
  | {
    kind: 'record-session-end';
    sessionId: string;
    outcome: SessionOutcome;
    summary: string;
    lessons: string[];
  }
  | {
    kind: 'record-workflow';
    name: string;
    steps: string[];
    applicableContexts: string[];
  }
  | {
    kind: 'record-strategy';
    strategy: string;
    conditions: string[];
    taskId: string;
    success: boolean;
    score: number;
  }
  | { kind: 'record-outcome'; taskId: string; success: boolean; score: number }
  | { kind: 'get-stats' }
  | { kind: 'get-sessions'; limit?: number }
  | { kind: 'get-patterns'; minSuccessRate?: number }
  | { kind: 'get-workflows' }
  | { kind: 'save' }
  | { kind: 'load'; snapshot: UnifiedMemorySnapshot }
  | { kind: 'configure'; config: Partial<UnifiedMemoryConfig> };

interface UnifiedMemoryWorkerResultByKind {
  'process-input': void;
  retrieve: UnifiedRetrievalResult;
  'record-session-end': void;
  'record-workflow': WorkflowMemory;
  'record-strategy': StrategyMemory;
  'record-outcome': void;
  'get-stats': UnifiedMemoryStats;
  'get-sessions': SessionMemory[];
  'get-patterns': LearnedPattern[];
  'get-workflows': WorkflowMemory[];
  save: UnifiedMemorySnapshot;
  load: void;
  configure: void;
}

export type UnifiedMemoryWorkerResult<
  TRequest extends UnifiedMemoryWorkerRequest = UnifiedMemoryWorkerRequest,
> = TRequest extends {
  kind: infer TKind extends keyof UnifiedMemoryWorkerResultByKind;
}
  ? UnifiedMemoryWorkerResultByKind[TKind]
  : never;

export class UnifiedMemoryWorkerRpcError extends Error {
  override readonly name: string = 'UnifiedMemoryWorkerRpcError';
}

export class UnifiedMemoryWorkerRpcTimeoutError extends UnifiedMemoryWorkerRpcError {
  override readonly name: string = 'UnifiedMemoryWorkerRpcTimeoutError';
}

export interface UnifiedMemoryWorkerPort {
  invokeUnifiedMemory<TRequest extends UnifiedMemoryWorkerRequest>(
    request: TRequest,
  ): Promise<UnifiedMemoryWorkerResult<TRequest>>;
}
