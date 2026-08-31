import type { ProviderRuntimeSnapshot } from '../cli/adapters/base-cli-adapter';
import { computeResumeConfigFingerprint } from '../instance/lifecycle/session-recovery';
import type { ResumeCursor, SessionState } from './session-continuity.types';

export function captureResumeCursorForState(options: {
  adapter: unknown;
  instanceId: string;
  state: SessionState;
  warn: (message: string, metadata: Record<string, unknown>) => void;
}): void {
  if (!options.adapter) return;
  const runtimeAdapter = options.adapter as {
    getRuntimeSnapshot?: () => ProviderRuntimeSnapshot;
    getResumeCursor?: () => unknown;
  };
  const snapshot = runtimeAdapter.getRuntimeSnapshot?.();
  const rawCursor = snapshot ? snapshot.resumeCursor : runtimeAdapter.getResumeCursor?.();
  const cursor = rawCursor && typeof rawCursor === 'object'
    ? { ...(rawCursor as ResumeCursor) }
    : null;
  if (snapshot?.nativeThreadId && cursor?.threadId !== snapshot.nativeThreadId) {
    options.warn('Refusing to persist a non-atomic provider runtime identity', {
      instanceId: options.instanceId,
      snapshotRevision: snapshot.revision,
    });
    return;
  }
  if (cursor && !cursor.configFingerprint) {
    cursor.configFingerprint = computeResumeConfigFingerprint({
      provider: options.state.provider,
      model: options.state.modelId,
      cwd: options.state.workingDirectory,
      copilotProfileId: options.state.copilotAccountProfileId,
    });
  }
  options.state.resumeCursor = cursor;
  if (snapshot?.providerSessionId) options.state.sessionId = snapshot.providerSessionId;
}
