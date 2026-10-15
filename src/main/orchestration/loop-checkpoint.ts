import type { LoopIteration, LoopState } from '../../shared/types/loop.types';
import { progressDetectorHistoryWindow } from './loop-progress-detector';

export const LOOP_CHECKPOINT_VERSION = 1 as const;
export const LOOP_CHECKPOINT_HISTORY_TAIL = 25;

export interface LoopCheckpointContext {
  convergenceNote: string | null;
  planRegenerationCount: number;
  pendingContextReset: boolean;
}

export function checkpointHistory(history: LoopIteration[], last?: LoopIteration | null): LoopIteration[] {
  const bySeq = new Map(history.map(row => [row.seq, row]));
  if (last) bySeq.set(last.seq, last);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function buildRunCheckpoint(source: {
  getIterations(id: string): LoopIteration[];
  getCheckpointContext(id: string): LoopCheckpointContext;
}, state: LoopState, last?: LoopIteration | null): LoopCheckpoint {
  return buildLoopCheckpoint({ state, history: checkpointHistory(source.getIterations(state.id), last), ...source.getCheckpointContext(state.id) });
}

export interface LoopCheckpoint {
  version: 1;
  loopRunId: string;
  chatId: string;
  status: LoopState['status'];
  state: LoopState;
  historyTail: LoopIteration[];
  convergenceNote: string | null;
  planRegenerationCount: number;
  pendingContextReset: boolean;
  updatedAt: number;
}

export function buildLoopCheckpoint(input: {
  state: LoopState;
  history: LoopIteration[];
  convergenceNote?: string | null;
  planRegenerationCount?: number;
  pendingContextReset?: boolean;
  now?: number;
}): LoopCheckpoint {
  const window = Math.min(LOOP_CHECKPOINT_HISTORY_TAIL, progressDetectorHistoryWindow(input.state.config.progressThresholds));
  const historyTail = input.history.slice(-window);
  return {
    version: LOOP_CHECKPOINT_VERSION,
    loopRunId: input.state.id,
    chatId: input.state.chatId,
    status: input.state.status,
    state: input.state,
    historyTail,
    convergenceNote: input.convergenceNote ?? null,
    planRegenerationCount: input.planRegenerationCount ?? 0,
    pendingContextReset: input.pendingContextReset ?? false,
    updatedAt: input.now ?? Date.now(),
  };
}
