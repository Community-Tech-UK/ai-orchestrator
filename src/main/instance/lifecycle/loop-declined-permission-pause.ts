/**
 * Pause a loop when the person declines the tool call it is holding.
 *
 * A declined call is answered to the model as a refusal, and the model then asks
 * to be allowed or cancelled. Every later iteration starts from the same goal and
 * runs into the same refusal, so the loop would spend a round per question until
 * the no-progress check parked it (seven rounds in about a minute were seen on a
 * real `/goal`, LT-1133). The person has already answered, so the loop waits for
 * them to resume or stop it instead.
 */

import { getLogger } from '../../logging/logger';

const logger = getLogger('LoopDeclinedPermissionPause');

interface LoopPauseTarget {
  getActiveLoops(): { id: string; chatId?: string; status?: string }[];
  pauseLoop(loopRunId: string): boolean;
}

/** The real coordinator, reached lazily so `src/main/instance` has no static dependency on orchestration. */
function defaultCoordinator(): LoopPauseTarget {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getLoopCoordinator } = require('../../orchestration/loop-coordinator') as {
    getLoopCoordinator: () => LoopPauseTarget;
  };
  return getLoopCoordinator();
}

/** Pause the running loop on this session, if any. Returns whether a loop was paused. */
export function pauseLoopForDeclinedPermission(
  instanceId: string,
  coordinator: () => LoopPauseTarget = defaultCoordinator,
): boolean {
  try {
    const target = coordinator();
    const loop = target.getActiveLoops().find((candidate) => candidate.chatId === instanceId && candidate.status === 'running');
    if (!loop) return false;
    const paused = target.pauseLoop(loop.id);
    if (paused) {
      logger.info('Loop paused: the person declined a tool call it was holding', { instanceId, loopRunId: loop.id });
    }
    return paused;
  } catch (error) {
    // The decision itself is already written; a pause failure must not undo it.
    logger.warn('Could not pause the loop after a declined tool call', {
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
