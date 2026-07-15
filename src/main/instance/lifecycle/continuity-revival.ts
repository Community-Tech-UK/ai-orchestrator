import type { Instance, InstanceCreateConfig, OutputMessage } from '../../../shared/types/instance.types';
import type { SessionState } from '../../session/session-continuity.types';

export interface ContinuityReviveRequest {
  sourceInstanceId: string;
  initialPrompt: string;
  reason: 'doc-review-submission';
}

export interface ContinuityReviveResult {
  instanceId: string;
  restoreMode: 'native' | 'replay';
}

export interface ContinuityRevivalDeps {
  resumeSession(
    instanceId: string,
    options: { restoreMessages: boolean; restoreContext: boolean },
  ): Promise<SessionState | null>;
  createInstance(config: InstanceCreateConfig): Promise<Instance>;
}

/** Build a new continuation from durable session state; never mutate the old runtime id. */
export async function reviveContinuitySession(
  deps: ContinuityRevivalDeps,
  request: ContinuityReviveRequest,
): Promise<ContinuityReviveResult> {
  const state = await deps.resumeSession(request.sourceInstanceId, {
    restoreMessages: true,
    restoreContext: true,
  });
  if (!state) throw new Error(`No archived continuity state exists for ${request.sourceInstanceId}`);

  const initialOutputBuffer: OutputMessage[] = state.conversationHistory.slice(-100).map((entry) => ({
    id: `continuity-${entry.id}`,
    timestamp: entry.timestamp,
    type: entry.role === 'user' ? 'user' : entry.role === 'assistant' ? 'assistant' : 'system',
    content: entry.content,
  }));
  const nativeSessionId = !state.nativeResumeFailedAt ? state.sessionId?.trim() : undefined;
  const instance = await deps.createInstance({
    workingDirectory: state.workingDirectory,
    displayName: state.displayName,
    isRenamed: state.isRenamed,
    isRestoredSession: true,
    historyThreadId: state.historyThreadId?.trim() || request.sourceInstanceId,
    ...(nativeSessionId ? { sessionId: nativeSessionId, resume: true } : {}),
    initialOutputBuffer,
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
  return { instanceId: instance.id, restoreMode: nativeSessionId ? 'native' : 'replay' };
}
