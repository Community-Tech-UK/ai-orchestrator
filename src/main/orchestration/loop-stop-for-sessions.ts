import { getLoopCoordinator } from './loop-coordinator';
import { isTerminalLoopRuntimeState } from './loop-runtime-status';

/** Stop loops before deliberately removing their visible owner sessions. */
export async function stopLoopsForSessions(ids: readonly string[], coordinator = getLoopCoordinator()): Promise<number> {
  const closing = new Set(ids);
  const loops = coordinator.getActiveLoops().filter(loop => closing.has(loop.chatId) && !isTerminalLoopRuntimeState(loop));
  await Promise.all(loops.map(loop => coordinator.cancelLoop(loop.id)));
  return loops.length;
}
