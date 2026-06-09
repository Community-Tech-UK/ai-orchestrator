import type { LoopIteration, LoopState } from '../../shared/types/loop.types';

export const LOOP_CHECKPOINT_VERSION = 1 as const;
export const LOOP_CHECKPOINT_HISTORY_TAIL = 25;

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
  const historyTail = input.history.slice(-LOOP_CHECKPOINT_HISTORY_TAIL);
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
