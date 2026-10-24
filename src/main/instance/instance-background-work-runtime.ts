import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliAsyncWorkEvent } from '../cli/adapters/claude-cli-async-work';
import type { OutputMessage } from '../../shared/types/instance.types';
import type { CommunicationDependencies } from './instance-communication.types';
import { getInstanceAsyncWorkRegistry } from './instance-async-work-registry';
import { getSessionContinuityManagerIfInitialized } from '../session/session-continuity';
import { outputMessageToContinuityEntry } from '../session/continuity-message-projection';

/** Preserve shutdown notices even when lifecycle cleanup removes adapter listeners. */
export function bindBackgroundWorkTerminationReporter(
  instanceId: string,
  adapter: CliAdapter,
  deps: Pick<CommunicationDependencies, 'getInstance' | 'getAdapter'>,
  report: (message: OutputMessage) => void,
): void {
  // Newly bound runtimes cannot inherit a predecessor's work or completion delivery.
  getInstanceAsyncWorkRegistry().clearInstance(instanceId);
  const instanceAtSubscribe = deps.getInstance(instanceId);
  const shutdownReporter = adapter as CliAdapter & {
    enableHarnessBackgroundWorkInstructions?: () => void;
    setBackgroundWorkTerminationReporter?: (reporter: ((message: OutputMessage) => void | Promise<void>) | null) => void;
  };
  // Shared prompt assembly runs before provider resolution. This binding knows
  // the actual adapter and confirms Harness owns its work and completion delivery.
  shutdownReporter.enableHarnessBackgroundWorkInstructions?.();
  shutdownReporter.setBackgroundWorkTerminationReporter?.((message) => {
    // Teardown may increment the epoch or register a replacement first. The old
    // runtime's stop notice belongs to this conversation, never another instance.
    if (!instanceAtSubscribe || deps.getInstance(instanceId) !== instanceAtSubscribe) return;
    const hibernating = instanceAtSubscribe.status === 'hibernating';
    report(message);
    const currentAdapter = deps.getAdapter(instanceId);
    if (!currentAdapter || currentAdapter === adapter) getInstanceAsyncWorkRegistry().clearInstance(instanceId);
    if (hibernating) return persistHibernationStopNotice(instanceId, message);
    return undefined;
  });
}

export function observeInstanceBackgroundWork(
  instanceId: string,
  event: CliAsyncWorkEvent,
  deps: Pick<CommunicationDependencies, 'getInstance' | 'onOutput'>,
): void {
  const instance = deps.getInstance(instanceId);
  if (!instance) return;
  // A poll proves existence, not progress. Treating it as output would postpone
  // the stalled-work check-in indefinitely while the command is stuck.
  if (event.phase !== 'snapshot') {
    instance.lastActivity = Date.now();
    deps.onOutput?.(instanceId);
  }
  getInstanceAsyncWorkRegistry().observe(instanceId, event);
}

/** Hibernation saved before killing the process; commit the later notice before wake can restore that file. */
async function persistHibernationStopNotice(instanceId: string, message: OutputMessage): Promise<void> {
  const continuity = getSessionContinuityManagerIfInitialized();
  if (!continuity) return;
  // The normal output-forwarding queue may also add this entry. Its stable id
  // makes the direct durable write replace that entry instead of duplicating it.
  if (!await continuity.addConversationEntry(instanceId, outputMessageToContinuityEntry(message))) return;
  await continuity.checkpointCompleteConversation(instanceId, continuity.captureConversationCheckpoint(instanceId));
}
