import type { Instance, InstanceStatus, OutputMessage } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import { isSurfacedToUserError } from '../../cli/adapters/surfaced-error';
import { getLogger } from '../../logging/logger';
import { errorDiagnostic } from '../../logging/source-diagnostics';
import { GlobalPauseService } from '../../global-pause/global-pause-service';
import { getSessionQueueService } from '../../session/session-queue-service';
import { assertAutomaticStartupCurrent, isAutomaticStartupCancelled } from '../../work-admission/automatic-startup';

import { isInitialPromptHeld } from './initial-prompt-dispatch';

const logger = getLogger('InitialPromptRecovery');
const pendingQueue = new WeakMap<Instance, { queued: boolean }>();
export function hasPendingInitialPrompt(instance: Instance): boolean { return pendingQueue.has(instance); }
export async function retryPendingInitialPrompt(instance: Instance): Promise<void> {
  if (pendingQueue.has(instance)) await queueInitialPromptForResume(instance);
}

/**
 * The regular-session provider-limit funnel, for a turn sent directly to the
 * adapter. Both methods return true when the limit took ownership of the turn
 * (parked, or moving to another pool account that re-sends `prompt`).
 */
export interface DirectTurnProviderLimitGate {
  holdBeforeSend(instance: Instance, prompt: string): boolean;
  handleSendError(instance: Instance, adapter: CliAdapter, error: unknown, prompt: string): boolean;
}

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
 * create failure path, which tears down the live runtime and parks the session
 * in `error` as one that could not start (see failed-creation-retention.ts).
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
  assertAutomaticStartupCurrent();
  if (GlobalPauseService.peek()?.holdsAutomaticInput(instance.id)) {
    await queueInitialPromptForResume(instance);
    return;
  }
  try {
    await send();
  } catch (error) {
    if (isInitialPromptHeld(error)) {
      await queueInitialPromptForResume(instance);
      return;
    }
    if (signal.aborted || isAutomaticStartupCancelled(error)) throw error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      'Initial prompt failed after successful spawn; preserving session',
      undefined,
      { instanceId: instance.id, ...errorDiagnostic(error) },
    );
    preserveSession(instance, errorMessage, deps, !isSurfacedToUserError(error));
  }
}

/** Queue persistence failures propagate so Pause cannot report a safe restart. */
async function queueInitialPromptForResume(instance: Instance): Promise<void> {
  const initial = [...instance.outputBuffer].reverse().find(message => message.type === 'user');
  if (!initial) throw new Error('The first message could not be saved for Resume');
  const pending = pendingQueue.get(instance) ?? { queued: false };
  pendingQueue.set(instance, pending);
  if (!pending.queued) await getSessionQueueService().enqueueUserMessage({ instanceId: instance.id, message: initial.content,
    attachments: initial.attachments?.map(attachment => ({ ...attachment, data: attachment.data ?? '' })),
    sourceMetadata: { seededAlready: true } });
  pending.queued = true;
  GlobalPauseService.peek()?.markInitialPromptQueued(instance.id);
  pendingQueue.delete(instance);
}

/**
 * Keep an instance alive and usable after its create-time initial prompt failed:
 * settle the runtime back to idle (a failed first turn may have left it busy) and
 * post a system notice so the user understands the first message did not send and
 * can resend — instead of the session silently disappearing.
 *
 * The notice is skipped when the adapter already explained the failure in the
 * transcript. That covers a first turn that ran for a long time and then paused
 * (a Codex context recovery), where "could not be delivered" would be false.
 */
function preserveSession(
  instance: Instance,
  errorMessage: string,
  deps: InitialPromptRecoveryDeps,
  postNotice: boolean,
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
  if (!postNotice) return;

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
