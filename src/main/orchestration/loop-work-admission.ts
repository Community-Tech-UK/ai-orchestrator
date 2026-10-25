import type { LoopState } from '../../shared/types/loop.types';
import { isAdapterOnLoan } from '../instance/lifecycle/adapter-loan-registry';
import { getWorkAdmission } from '../work-admission/work-admission';
const restartInterruptedRounds = new Set<string>();
export function consumeGlobalPauseInterruption(id: string): boolean { return restartInterruptedRounds.delete(id); }

export function loopRoundAdmitted(state: LoopState, states: readonly LoopState[]): boolean {
  return state.status === 'running' && getWorkAdmission().check('loop-round', {
    activeCount: states.filter(candidate => candidate.id !== state.id && candidate.inFlightIteration).length,
  }).allowed;
}

interface PauseLoopHost {
  getLoop(id: string): LoopState | undefined;
  pauseLoop(id: string): boolean;
  emit(event: string, payload: unknown): boolean;
}

/** Preserve the loop checkpoint and wait for the turn/adapter loan to settle. */
export async function pauseLoopForGlobalPause(host: PauseLoopHost, loopRunId: string): Promise<void> {
  const before = host.getLoop(loopRunId);
  if (!before || !host.pauseLoop(loopRunId)) return;
  if (before.inFlightIteration) restartInterruptedRounds.add(loopRunId);
  host.emit('loop:pause-for-restart', { loopRunId, seq: before.inFlightIteration?.seq });
  const deadline = Date.now() + 35_000;
  while (host.getLoop(loopRunId)?.inFlightIteration || isAdapterOnLoan(before.chatId)) {
    if (Date.now() >= deadline) throw new Error('A loop is still stopping. Wait before restarting Harness.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  restartInterruptedRounds.delete(loopRunId);
}
