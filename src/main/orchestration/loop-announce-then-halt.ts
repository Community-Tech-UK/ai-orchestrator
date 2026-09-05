import {
  createLoopPendingInput,
  type LoopIteration,
  type LoopState,
} from '../../shared/types/loop.types';
import {
  detectAnnounceThenHalt,
} from './announce-then-halt-detector';

export { detectAnnounceThenHalt } from './announce-then-halt-detector';
export type { AnnounceThenHaltMatch } from './announce-then-halt-detector';

const MAX_ANNOUNCE_THEN_HALT_NUDGES = 2;

export function maybeQueueAnnounceThenHaltContinuation(
  state: LoopState,
  iteration: LoopIteration,
): boolean {
  if (iteration.stage !== 'IMPLEMENT') return false;
  if (iteration.toolCalls.length > 0 || iteration.filesChanged.length > 0) return false;
  if (iteration.completionSignalsFired.some((signal) => signal.sufficient)) return false;
  if (state.pendingInterventions.length > 0) return false;

  const count = state.announceThenHaltNudgeCount ?? 0;
  if (count >= MAX_ANNOUNCE_THEN_HALT_NUDGES) return false;

  const detected = detectAnnounceThenHalt(iteration.outputFull || iteration.outputExcerpt);
  if (!detected) return false;

  state.announceThenHaltNudgeCount = count + 1;
  state.pendingInterventions.push(createLoopPendingInput(
    [
      'Continue now. You ended the last iteration by announcing the next action instead of executing it.',
      'Execute the required tool calls or file edits now; do not narrate plans without acting.',
      `Announced intent: "${detected.excerpt}"`,
    ].join(' '),
    { kind: 'queue', source: 'announce-then-halt' },
  ));
  return true;
}
