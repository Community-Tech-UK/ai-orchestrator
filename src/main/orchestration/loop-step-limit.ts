import { createLoopPendingInput, type LoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';
export function stepLimitNote(config: LoopConfig): string {
  const n = config.maxTurnsPerIteration;
  if (config.provider !== 'claude' || typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return '';
  return `Round limit: this round runs for up to ${n} turns (a turn is one tool-using step). Keep NOTES.md and the task list up to date as you work, and by about turn ${Math.floor(n * 0.8)} write down where you are so the next round can pick up from there. Carry on working normally until the round ends; the limit is a boundary, not a reason to wrap up early.`;
}
export function maybeQueueStepLimitContinuation(state: LoopState, iteration: LoopIteration): boolean {
  if (!stepLimitNote(state.config) || iteration.finishReason !== 'max_turns' || state.pendingInterventions.length || iteration.completionSignalsFired.some(signal => signal.sufficient)) return false;
  state.pendingInterventions.push(createLoopPendingInput(`Your previous round stopped because it reached the ${state.config.maxTurnsPerIteration}-turn limit with work still in progress. Pick up from where it stopped (your notes and the task list show where that was); steps already done do not need repeating.`, { kind: 'queue', source: 'step-limit' }));
  return true;
}
