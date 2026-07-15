import type { Instance, InstanceStatus, OutputMessage } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { getLogger } from '../../logging/logger';

const logger = getLogger('InitialPromptRecovery');

export interface InitialPromptRecoveryDeps {
  transitionState(instance: Instance, status: InstanceStatus): void;
  queueUpdate(instance: Instance): void;
  addToOutputBuffer(instance: Instance, message: OutputMessage): void;
  emitOutput(instanceId: string, message: OutputMessage): void;
}

/**
 * Deliver the create-time initial prompt after the CLI has already spawned and
 * settled to idle. Post-spawn the instance is a real, live session, so a failure
 * delivering the first turn must NOT be fatal: throwing here propagates to the
 * spawn-transaction rollback, which deletes the instance and makes the session
 * vanish from the session list.
 *
 * Codex in particular fails this first turn in several ways while the session is
 * healthy — context-cost recovery pausing on an unconfirmed interrupt, or the
 * app-server dropping mid-turn. In every such case we keep the session, surface
 * the reason, and settle it back to idle so the user can simply resend.
 *
 * An in-flight abort is the one exception: it is a deliberate teardown, so we
 * rethrow and let the caller's rollback path run as before.
 */
export async function deliverInitialPromptAfterSpawn(
  instance: Instance,
  signal: AbortSignal,
  send: () => Promise<void>,
  deps: InitialPromptRecoveryDeps,
): Promise<void> {
  try {
    await send();
  } catch (error) {
    if (signal.aborted) throw error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      'Initial prompt failed after successful spawn; preserving session',
      error instanceof Error ? error : undefined,
      { instanceId: instance.id, errorMessage },
    );
    preserveSession(instance, errorMessage, deps);
  }
}

/**
 * Keep an instance alive and usable after its create-time initial prompt failed:
 * settle the runtime back to idle (a failed first turn may have left it busy) and
 * post a system notice so the user understands the first message did not send and
 * can resend — instead of the session silently disappearing.
 */
function preserveSession(
  instance: Instance,
  errorMessage: string,
  deps: InitialPromptRecoveryDeps,
): void {
  if (
    instance.status !== 'idle' &&
    instance.status !== 'terminated' &&
    instance.status !== 'error'
  ) {
    try {
      deps.transitionState(instance, 'idle');
    } catch {
      // The state machine may forbid the transition from a terminal-ish state;
      // the notice below still keeps the user informed.
    }
  }
  deps.queueUpdate(instance);

  const notice: OutputMessage = {
    id: generateId(),
    timestamp: Date.now(),
    type: 'system',
    content: `The initial message could not be delivered and the session was kept open. Reason: ${errorMessage}`,
    metadata: {
      source: 'initial-prompt-failed',
      initialPromptFailed: true,
    },
  };
  deps.addToOutputBuffer(instance, notice);
  deps.emitOutput(instance.id, notice);
}
