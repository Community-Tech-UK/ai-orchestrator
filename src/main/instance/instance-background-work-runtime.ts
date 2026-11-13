import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliAsyncWorkEvent } from '../cli/adapters/claude-cli-async-work';
import type { OutputMessage } from '../../shared/types/instance.types';
import type { CommunicationDependencies } from './instance-communication.types';
import type { StoppedHelper } from '../session/session-continuity.types';
import { getInstanceAsyncWorkRegistry } from './instance-async-work-registry';
import { getSessionContinuityManagerIfInitialized } from '../session/session-continuity';
import { outputMessageToContinuityEntry } from '../session/continuity-message-projection';
import { getLogger } from '../logging/logger';
import { errorDiagnostic } from '../logging/source-diagnostics';

const logger = getLogger('InstanceCommunication');

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
    // Started before report/clearInstance so a stop is persisted before the
    // registry forgets the work; the awaited chain keeps shutdown honest.
    const stoppedHelpersSaved = persistStoppedHelpersForResume(instanceId, message);
    report(message);
    const currentAdapter = deps.getAdapter(instanceId);
    if (!currentAdapter || currentAdapter === adapter) getInstanceAsyncWorkRegistry().clearInstance(instanceId);
    if (!hibernating) return stoppedHelpersSaved;
    return stoppedHelpersSaved.then(() => persistHibernationStopNotice(instanceId, message));
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

/** Well-formed `metadata.stoppedHelpers` entries only; malformed ones are skipped, never guessed. */
function readStoppedHelpersMetadata(message: OutputMessage): StoppedHelper[] {
  const raw = message.metadata?.['stoppedHelpers'];
  if (!Array.isArray(raw)) return [];
  const helpers: StoppedHelper[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const toolUseId = record['toolUseId'];
    const sessionId = record['sessionId'];
    const lastActivityAt = record['lastActivityAt'];
    if (typeof toolUseId !== 'string' || toolUseId.length === 0) continue;
    if (typeof sessionId !== 'string') continue;
    if (typeof lastActivityAt !== 'number' || !Number.isFinite(lastActivityAt)) continue;
    const agentId = record['agentId'];
    const transcriptPath = record['transcriptPath'];
    const toolUseCount = record['toolUseCount'];
    helpers.push({
      toolUseId,
      ...(typeof agentId === 'string' && agentId.length > 0 ? { agentId } : {}),
      sessionId,
      ...(typeof transcriptPath === 'string' && transcriptPath.length > 0 ? { transcriptPath } : {}),
      ...(typeof toolUseCount === 'number' && Number.isFinite(toolUseCount) ? { toolUseCount } : {}),
      lastActivityAt,
    });
  }
  return helpers;
}

/**
 * Durable-saves helpers stopped with the process before the registry clears
 * their work. Never rejects: a save failure must not skip the notice chain.
 */
async function persistStoppedHelpersForResume(instanceId: string, message: OutputMessage): Promise<void> {
  const helpers = readStoppedHelpersMetadata(message);
  if (helpers.length === 0) return;
  try {
    await getSessionContinuityManagerIfInitialized()?.persistStoppedHelpers(instanceId, helpers);
  } catch (error) {
    logger.warn('Could not persist stopped helper agents', { instanceId, ...errorDiagnostic(error) });
  }
}
