import { buildReplayContinuityMessage } from '../session/replay-continuity';
import type { InstanceManager } from '../instance/instance-manager';
import { getLogger } from '../logging/logger';

const logger = getLogger('LoopExistingSessionContext');

export function buildExistingSessionContext(
  instanceManager: InstanceManager,
  chatId: string,
): string | undefined {
  const instance = instanceManager.getInstance(chatId);
  if (!instance || instance.outputBuffer.length === 0) {
    return undefined;
  }

  const context = buildReplayContinuityMessage(instance.outputBuffer, {
    reason: 'loop-existing-session',
    maxTurns: 24,
    maxCharsPerMessage: 1000,
  });
  if (!context) {
    return undefined;
  }

  logger.info('Attached existing session context to loop start', {
    chatId,
    messageCount: instance.outputBuffer.length,
    contextLength: context.length,
  });

  return [
    context,
    '',
    'Use this as prior context from the existing visible session. It is read-only background; the loop goal remains the current task.',
  ].join('\n');
}
