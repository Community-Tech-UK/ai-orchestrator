import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { presentFailure } from '../instance-failure-presentation';
import type { InitialPromptRecoveryDeps } from './initial-prompt-recovery';

/**
 * Create-transaction rollback labels that make up the session RECORD: the
 * store entry the session list renders, its transcript and prompt history, its
 * lifecycle state machine, and the registrations that normal termination
 * already tears down (termination coordinator + the manager's `removed`
 * listener). Everything else registered on the create transaction (adapter,
 * RLM session, stuck tracking) is runtime and is still rolled back.
 *
 * Keep in sync with the `addRollback` labels in `createInstanceInternal`.
 */
export const SESSION_RECORD_ROLLBACK_LABELS: ReadonlySet<string> = new Set([
  'instance-scopes',
  'instance-state',
  'pending-state',
  'output-storage',
  'state-machine',
  'parent-child-link',
  'supervisor-tree',
  'orchestration-registry',
  'prompt-history',
]);

/**
 * Whether a failed create should keep its session visible instead of deleting
 * it. Rolling back a published session used to delete it, so every pre-spawn
 * failure (a refused provider/mode combination, a missing directory, a
 * provider concurrency timeout, an ACP handshake error) made the session and
 * the user's prompt vanish from the list with no explanation.
 *
 * Unpublished recovery creations and crash-recovery replacements stay fully
 * transactional: recovery owns them and nothing was ever shown for them.
 */
export function shouldRetainFailedCreation(input: {
  deferPublication: boolean;
  isCrashRecovery: boolean;
}): boolean {
  return !input.deferPublication && !input.isCrashRecovery;
}

/**
 * Settle a session whose runtime could not start into `error`, with what happened
 * posted beneath the user's prompt so they can restart it or start a corrected
 * session. The notice says it in plain words; the real reason, with secrets
 * removed, is under its Details.
 */
export function retainFailedCreation(
  instance: Instance,
  error: unknown,
  deps: InitialPromptRecoveryDeps,
): void {
  if (instance.status !== 'error') {
    try {
      deps.transitionState(instance, 'error');
    } catch {
      // A state the machine will not leave for `error` still keeps the record
      // and the notice below, which is what stops the session vanishing.
    }
  }
  // Transcript output is only redacted for recovery sessions, and a launch error can echo
  // argv or env, so presentFailure scrubs the reason the way the rollback log does.
  const failure = presentFailure({
    error,
    message: error instanceof Error ? error.message : String(error),
    instance,
    lead: 'This session could not start.',
  });
  const notice: OutputMessage = {
    id: generateId(),
    timestamp: Date.now(),
    type: 'error',
    content: failure.content,
    metadata: { source: 'session-start-failed', ...failure.metadata },
  };
  deps.addToOutputBuffer(instance, notice);
  deps.emitOutput(instance.id, notice);
  deps.queueUpdate(instance);
}
