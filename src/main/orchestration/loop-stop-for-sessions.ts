import type { LoopState } from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';
import { isTerminalLoopRuntimeState } from './loop-runtime-status';

const logger = getLogger('SessionLoopStop');

export interface SessionLoopStopCoordinator {
  getActiveLoops(): Pick<LoopState, 'id' | 'chatId' | 'status' | 'endedAt'>[];
  cancelLoop(loopRunId: string): Promise<boolean>;
}

export async function stopLoopsForSessions(
  ids: readonly string[],
  coordinator?: SessionLoopStopCoordinator,
): Promise<number> {
  if (ids.length === 0) return 0;
  // ChatService can be used without Electron. Load the runtime only for a
  // deliberate close, avoiding a module-scope dependency cycle through chats.
  coordinator ??= (await import('./loop-coordinator')).getLoopCoordinator();
  const closing = new Set(ids);
  const loops = coordinator.getActiveLoops().filter((loop) =>
    closing.has(loop.chatId) && !isTerminalLoopRuntimeState(loop));
  const results = await Promise.allSettled(loops.map((loop) =>
    Promise.resolve().then(() => coordinator.cancelLoop(loop.id))));
  let stopped = 0;
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      if (result.value) stopped++;
    } else {
      logger.warn('Failed to stop loop before closing its session', {
        loopRunId: loops[index].id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
  return stopped;
}
