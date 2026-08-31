import type { Instance, InstanceCreateConfig, OutputMessage } from '../../../shared/types/instance.types';
import type { ResolvedRecoveryCandidate } from '../../session/session-recovery-candidate-service';
import { buildReplayContinuityMessage } from '../../session/replay-continuity';
import { reconcileRecoveryTranscript } from '../../session/recovery-transcript-reconciler';
import {
  continuityEntryToOutputMessage,
  outputMessagesToContinuityEntries,
} from '../../session/continuity-message-projection';
import type { ConversationEntry, ResumeCursor, SessionState } from '../../session/session-continuity.types';
import { promptsDiscardedByTruncation } from '../prompt-retention';
import { computeResumeConfigFingerprint } from './session-recovery';

/** Messages a document-review revival restores into its visible buffer. */
const REVIVED_MESSAGES = 100;
const RECOVERY_CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const FAILED_START_STATUSES = new Set([
  'failed', 'error', 'terminated', 'cancelled', 'superseded', 'hibernated',
]);
const OUTPUT_MESSAGE_TYPES = new Set([
  'assistant', 'user', 'system', 'tool_use', 'tool_result', 'error',
]);
const CONVERSATION_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

export type ContinuityReviveRequest =
  | {
      sourceInstanceId: string;
      initialPrompt: string;
      reason: 'doc-review-submission';
    }
  | {
      sourceInstanceId: string;
      reason: 'crash-recovery';
      resolvedCandidate: ResolvedRecoveryCandidate;
    };

export interface ContinuityReviveResult {
  instanceId: string;
  restoreMode: 'native' | 'replay';
  recoveredMessageCount?: number;
}

export interface ContinuityRecoveryCreation {
  readonly instance: Instance;
  publish(): Promise<void>;
  rollback(cause: unknown): Promise<void>;
}

export interface ContinuityRevivalDeps {
  resumeSession(
    instanceId: string,
    options: { restoreMessages: boolean; restoreContext: boolean },
  ): Promise<SessionState | null>;
  createInstance(config: InstanceCreateConfig): Promise<Instance>;
  createRecoveryInstance?(config: InstanceCreateConfig): Promise<ContinuityRecoveryCreation>;
  queueContinuityPreamble?(instanceId: string, preamble: string): void;
  now?(): number;
}

function recoveryValidationError(): Error {
  return new Error('Recovery candidate validation failed');
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw recoveryValidationError();
  }
  return value.trim();
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireNonEmptyString(value);
}

function normalizedWorkspace(value: string): string {
  const normalized = value.trim().replace(/\\/gu, '/').replace(/\/+$/gu, '');
  return normalized || '/';
}

function assertOutputMessage(message: OutputMessage): void {
  requireNonEmptyString(message.id);
  if (!OUTPUT_MESSAGE_TYPES.has(message.type)) throw recoveryValidationError();
  if (typeof message.content !== 'string' || !Number.isFinite(message.timestamp)) {
    throw recoveryValidationError();
  }
  if (message.metadata !== undefined
      && (message.metadata === null || typeof message.metadata !== 'object')) {
    throw recoveryValidationError();
  }
}

function assertConversationEntry(entry: ConversationEntry): void {
  requireNonEmptyString(entry.id);
  if (!CONVERSATION_ROLES.has(entry.role)) throw recoveryValidationError();
  if (typeof entry.content !== 'string' || !Number.isFinite(entry.timestamp)) {
    throw recoveryValidationError();
  }
  if (entry.tokens !== undefined && !Number.isFinite(entry.tokens)) {
    throw recoveryValidationError();
  }
  if (entry.thinking !== undefined && typeof entry.thinking !== 'string') {
    throw recoveryValidationError();
  }
  if (entry.isCompacted !== undefined && typeof entry.isCompacted !== 'boolean') {
    throw recoveryValidationError();
  }
  if (entry.toolUse) {
    requireNonEmptyString(entry.toolUse.toolName);
    if (entry.toolUse.output !== undefined && typeof entry.toolUse.output !== 'string') {
      throw recoveryValidationError();
    }
  }
}

function validateResolvedCandidate(
  requestSourceInstanceId: string,
  resolved: ResolvedRecoveryCandidate,
): void {
  const requestedSource = requireNonEmptyString(requestSourceInstanceId);
  const candidateSource = requireNonEmptyString(resolved.candidate.sourceInstanceId);
  const stateSource = requireNonEmptyString(resolved.continuityState.instanceId);
  if (requestedSource !== candidateSource || candidateSource !== stateSource) {
    throw recoveryValidationError();
  }

  requireNonEmptyString(resolved.candidate.recoveryKey);
  requireNonEmptyString(resolved.candidate.provider);
  requireNonEmptyString(resolved.continuityState.displayName);
  requireNonEmptyString(resolved.continuityState.agentId);
  if (typeof resolved.continuityState.modelId !== 'string'
      || !Array.isArray(resolved.continuityState.conversationHistory)) {
    throw recoveryValidationError();
  }
  const stateWorkspace = requireNonEmptyString(resolved.continuityState.workingDirectory);
  if (!Number.isFinite(resolved.candidate.lastActivityAt)
      || !Number.isInteger(resolved.candidate.recoveredMessageCount)
      || resolved.candidate.recoveredMessageCount < 0) {
    throw recoveryValidationError();
  }
  if (resolved.continuityState.nativeResumeFailedAt !== undefined
      && resolved.continuityState.nativeResumeFailedAt !== null
      && !Number.isFinite(resolved.continuityState.nativeResumeFailedAt)) {
    throw recoveryValidationError();
  }

  const stateProvider = resolved.continuityState.provider;
  if (stateProvider && stateProvider !== resolved.candidate.provider) {
    throw recoveryValidationError();
  }
  const candidateWorkspace = optionalTrimmedString(resolved.candidate.workingDirectory);
  if (candidateWorkspace
      && normalizedWorkspace(candidateWorkspace) !== normalizedWorkspace(stateWorkspace)) {
    throw recoveryValidationError();
  }

  const candidateThread = optionalTrimmedString(resolved.candidate.historyThreadId);
  const stateThread = optionalTrimmedString(resolved.continuityState.historyThreadId);
  if (candidateThread && stateThread && candidateThread !== stateThread) {
    throw recoveryValidationError();
  }

  for (const entry of resolved.continuityState.conversationHistory) {
    assertConversationEntry(entry);
  }

  const history = resolved.historyConversation;
  if (!history) return;
  if (!history.entry || !Array.isArray(history.messages)) throw recoveryValidationError();
  const historyProvider = history.entry.provider;
  if (historyProvider && historyProvider !== resolved.candidate.provider) {
    throw recoveryValidationError();
  }
  const historyThread = optionalTrimmedString(history.entry.historyThreadId);
  const expectedThread = stateThread ?? candidateThread;
  if (historyThread && expectedThread && historyThread !== expectedThread) {
    throw recoveryValidationError();
  }
  for (const message of history.messages) assertOutputMessage(message);
}

function cloneOutputMessages(messages: readonly OutputMessage[]): OutputMessage[] {
  try {
    return structuredClone(messages) as OutputMessage[];
  } catch {
    throw recoveryValidationError();
  }
}

function buildRecoveryBuffer(resolved: ResolvedRecoveryCandidate): {
  initialOutputBuffer: OutputMessage[];
  recoveredMessageCount: number;
} {
  const archivedOutput = resolved.historyConversation?.messages ?? [];
  const archivedEntries = outputMessagesToContinuityEntries(archivedOutput);
  const reconciled = reconcileRecoveryTranscript(
    archivedEntries,
    resolved.continuityState.conversationHistory,
  );
  const recoveredSuffix = reconciled.messages
    .slice(reconciled.archivedCount)
    .map(continuityEntryToOutputMessage);
  return {
    initialOutputBuffer: [...cloneOutputMessages(archivedOutput), ...recoveredSuffix],
    recoveredMessageCount: reconciled.recoveredCount,
  };
}

function isValidNativeCursor(
  resolved: ResolvedRecoveryCandidate,
  cursor: ResumeCursor | null | undefined,
  now: number,
): cursor is ResumeCursor {
  if (!resolved.candidate.nativeResumeAvailable
      || resolved.continuityState.nativeResumeFailedAt !== undefined
        && resolved.continuityState.nativeResumeFailedAt !== null) {
    return false;
  }
  if (!cursor
      || typeof cursor.provider !== 'string'
      || typeof cursor.threadId !== 'string'
      || typeof cursor.workspacePath !== 'string'
      || !Number.isFinite(cursor.capturedAt)
      || cursor.threadId.trim().length === 0
      || cursor.capturedAt > now
      || cursor.capturedAt <= now - RECOVERY_CURSOR_MAX_AGE_MS) {
    return false;
  }
  const provider = resolved.continuityState.provider ?? resolved.candidate.provider;
  if (cursor.provider.trim() !== provider
      || normalizedWorkspace(cursor.workspacePath)
        !== normalizedWorkspace(resolved.continuityState.workingDirectory)) {
    return false;
  }
  const currentFingerprint = computeResumeConfigFingerprint({
    provider,
    model: resolved.continuityState.modelId,
    cwd: resolved.continuityState.workingDirectory,
    copilotProfileId: resolved.continuityState.copilotAccountProfileId,
  });
  return !cursor.configFingerprint
    || !currentFingerprint
    || cursor.configFingerprint === currentFingerprint;
}

async function reviveCrashRecovery(
  deps: ContinuityRevivalDeps,
  request: Extract<ContinuityReviveRequest, { reason: 'crash-recovery' }>,
): Promise<ContinuityReviveResult> {
  validateResolvedCandidate(request.sourceInstanceId, request.resolvedCandidate);
  if (!deps.createRecoveryInstance) throw recoveryValidationError();
  const resolved = request.resolvedCandidate;
  const state = resolved.continuityState;
  let recoveryBuffer: ReturnType<typeof buildRecoveryBuffer>;
  try {
    recoveryBuffer = buildRecoveryBuffer(resolved);
  } catch {
    throw recoveryValidationError();
  }
  const { initialOutputBuffer, recoveredMessageCount } = recoveryBuffer;
  const cursor = state.resumeCursor;
  const nativeCursor = isValidNativeCursor(resolved, cursor, deps.now?.() ?? Date.now())
    ? cursor
    : undefined;
  const historyThreadId = state.historyThreadId?.trim()
    || resolved.candidate.historyThreadId?.trim()
    || undefined;
  let replacement: Instance | undefined;
  let creation: ContinuityRecoveryCreation | undefined;

  try {
    creation = await deps.createRecoveryInstance({
      workingDirectory: state.workingDirectory,
      displayName: state.displayName,
      isRenamed: state.isRenamed,
      isRestoredSession: true,
      ...(historyThreadId ? { historyThreadId } : {}),
      ...(nativeCursor ? { sessionId: nativeCursor.threadId.trim(), resume: true } : {}),
      initialOutputBuffer,
      agentId: state.agentId,
      provider: state.provider ?? resolved.candidate.provider,
      modelOverride: state.modelId?.trim() || undefined,
      copilotAccountProfileId: state.copilotAccountProfileId,
      metadata: {
        continuityRevival: true,
        reason: request.reason,
      },
    });
    replacement = creation.instance;
    if (!replacement.id?.trim() || replacement.id === request.sourceInstanceId) {
      throw new Error('Replacement runtime identity was not new');
    }
    const readyPromise = replacement.readyPromise;
    if (readyPromise) await readyPromise;
    if (FAILED_START_STATUSES.has(replacement.status)) {
      throw new Error('Replacement runtime did not become ready');
    }
    if (!nativeCursor) {
      const preamble = buildReplayContinuityMessage(initialOutputBuffer, {
        reason: request.reason,
      });
      if (preamble) {
        if (!deps.queueContinuityPreamble) {
          throw new Error('Replay continuity queue is unavailable');
        }
        deps.queueContinuityPreamble(replacement.id, preamble);
      }
    }
    await creation.publish();
  } catch (error) {
    if (creation && replacement?.id && replacement.id !== request.sourceInstanceId) {
      try {
        await creation.rollback(error);
      } catch {
        // Preserve the original startup failure; lifecycle teardown is best effort.
      }
    }
    throw new Error('Recovery replacement failed to start');
  }

  return {
    instanceId: replacement.id,
    restoreMode: nativeCursor ? 'native' : 'replay',
    recoveredMessageCount,
  };
}

async function reviveDocReview(
  deps: ContinuityRevivalDeps,
  request: Extract<ContinuityReviveRequest, { reason: 'doc-review-submission' }>,
): Promise<ContinuityReviveResult> {
  const state = await deps.resumeSession(request.sourceInstanceId, {
    restoreMessages: true,
    restoreContext: true,
  });
  if (!state) throw new Error(`No archived continuity state exists for ${request.sourceInstanceId}`);

  const history = state.conversationHistory;
  const initialOutputBuffer: OutputMessage[] = history.slice(-REVIVED_MESSAGES).map((entry) => ({
    id: `continuity-${entry.id}`,
    timestamp: entry.timestamp,
    type: entry.role === 'user' ? 'user' : entry.role === 'assistant' ? 'assistant' : 'system',
    content: entry.content,
  }));
  // Revival keeps only the newest messages, so carry the prompts it drops or
  // the revived thread cannot state what it was originally asked to do.
  const initialRetainedPrompts = promptsDiscardedByTruncation(
    history,
    REVIVED_MESSAGES,
    'continuity-prompt-',
  );
  const nativeSessionId = !state.nativeResumeFailedAt ? state.sessionId?.trim() : undefined;
  const instance = await deps.createInstance({
    workingDirectory: state.workingDirectory,
    displayName: state.displayName,
    isRenamed: state.isRenamed,
    isRestoredSession: true,
    historyThreadId: state.historyThreadId?.trim() || request.sourceInstanceId,
    ...(nativeSessionId ? { sessionId: nativeSessionId, resume: true } : {}),
    initialOutputBuffer,
    initialRetainedPrompts,
    initialPrompt: request.initialPrompt,
    agentId: state.agentId,
    provider: state.provider,
    modelOverride: state.modelId || undefined,
    metadata: {
      continuityRevival: true,
      sourceInstanceId: request.sourceInstanceId,
      reason: request.reason,
    },
  });
  if (instance.readyPromise) await instance.readyPromise;
  return {
    instanceId: instance.id,
    restoreMode: nativeSessionId ? 'native' : 'replay',
  };
}

/** Build a new continuation from durable session state; never mutate the old runtime id. */
export async function reviveContinuitySession(
  deps: ContinuityRevivalDeps,
  request: ContinuityReviveRequest,
): Promise<ContinuityReviveResult> {
  return request.reason === 'crash-recovery'
    ? reviveCrashRecovery(deps, request)
    : reviveDocReview(deps, request);
}
/**
 * Revival rebuilds a new instance from durable session state and keeps only the
 * newest slice for document review, so retained prompts protect the original
 * request. Crash recovery instead reconciles the full archived prefix.
 */
