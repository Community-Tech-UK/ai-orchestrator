import { createRequire } from 'node:module';
import type { LoopState } from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';
import { isActiveLoopRuntimeState } from './loop-runtime-status';

const logger = getLogger('SessionLoopOwnership');
const loadCoordinator = createRequire(__filename);
type LoopOwnershipView = Pick<LoopState, 'chatId' | 'status' | 'endedAt'>;

function getActiveLoops(): LoopOwnershipView[] {
  // Lifecycle and process modules also participate in coordinator imports.
  // Resolve only at inspection time to keep their module graphs acyclic.
  const { getLoopCoordinator } = loadCoordinator('./loop-coordinator') as typeof import('./loop-coordinator');
  return getLoopCoordinator().getActiveLoops();
}

/** Running, paused and provider-parked loops retain ownership of their chat. */
export function sessionHostsActiveLoop(
  instanceId: string,
  readLoops: () => readonly LoopOwnershipView[] = getActiveLoops,
): boolean {
  try {
    return readLoops().some((loop) => loop.chatId === instanceId && isActiveLoopRuntimeState(loop));
  } catch {
    logger.warn('Cannot inspect loop ownership; preserving session', { instanceId });
    return true;
  }
}
