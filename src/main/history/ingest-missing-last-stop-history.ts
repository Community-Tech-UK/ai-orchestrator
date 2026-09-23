import { createInstance } from '../../shared/types/instance.types';
import type { Instance, InstanceProvider } from '../../shared/types/instance.types';
import type { RecoverableSessionSelectionInput } from '../session/recoverable-session-selection';

const KNOWN_PROVIDERS = new Set<InstanceProvider>([
  'claude',
  'gemini',
  'antigravity',
  'codex',
  'copilot',
  'cursor',
  'grok',
  'opencode',
  'auto',
]);

export interface IngestMissingLastStopHistoryDeps {
  sessions: readonly RecoverableSessionSelectionInput[];
  hasHistoryThread: (historyThreadId: string) => boolean;
  archiveInstance: (instance: Instance) => Promise<void>;
  shouldIngest?: (session: RecoverableSessionSelectionInput) => boolean | Promise<boolean>;
}

export interface IngestMissingLastStopHistoryResult {
  ingested: string[];
  skipped: string[];
  failed: Array<{ instanceId: string; error: string }>;
}

export function historyThreadIdFromLastStopSession(
  session: Pick<RecoverableSessionSelectionInput, 'historyThreadId' | 'recoveryKey'>,
): string | null {
  const fromField = session.historyThreadId?.trim();
  if (fromField) {
    return fromField;
  }

  const match = /^history:[^:]+:(.+)$/.exec(session.recoveryKey.trim());
  const fromKey = match?.[1]?.trim();
  return fromKey || null;
}

export function providerFromLastStopSession(
  session: Pick<RecoverableSessionSelectionInput, 'provider' | 'recoveryKey'>,
): InstanceProvider {
  const declared = session.provider?.trim();
  if (declared && KNOWN_PROVIDERS.has(declared as InstanceProvider) && declared !== 'auto') {
    return declared as InstanceProvider;
  }

  const match = /^(?:history|session):([^:]+):/.exec(session.recoveryKey.trim());
  const fromKey = match?.[1]?.trim();
  if (fromKey && KNOWN_PROVIDERS.has(fromKey as InstanceProvider) && fromKey !== 'auto') {
    return fromKey as InstanceProvider;
  }

  return 'claude';
}

export function buildArchiveInstanceFromLastStopSession(
  session: RecoverableSessionSelectionInput,
): Instance | null {
  const historyThreadId = historyThreadIdFromLastStopSession(session);
  const workingDirectory = session.workingDirectory?.trim();
  if (!historyThreadId || !workingDirectory) {
    return null;
  }

  const provider = providerFromLastStopSession(session);
  if (provider === 'gemini') {
    return null;
  }

  const instance = createInstance({
    displayName: session.displayName,
    workingDirectory,
    provider,
    modelOverride: session.modelId,
    historyThreadId,
    sessionId: session.sessionId,
  });
  instance.id = session.instanceId;
  instance.status = 'idle';
  instance.lastActivity = session.lastActivityAt;
  instance.currentModel = session.modelId;
  if (session.sessionId?.trim()) {
    instance.providerSessionId = session.sessionId.trim();
    instance.sessionId = session.sessionId.trim();
  }
  return instance;
}

export async function ingestMissingLastStopSessionsIntoHistory(
  deps: IngestMissingLastStopHistoryDeps,
): Promise<IngestMissingLastStopHistoryResult> {
  const ingested: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ instanceId: string; error: string }> = [];
  const ingestedThreads = new Set<string>();

  for (const session of deps.sessions) {
    const historyThreadId = historyThreadIdFromLastStopSession(session);
    if (
      !historyThreadId
      || ingestedThreads.has(historyThreadId)
      || deps.hasHistoryThread(historyThreadId)
    ) {
      skipped.push(session.instanceId);
      continue;
    }

    if (deps.shouldIngest && !await deps.shouldIngest(session)) {
      skipped.push(session.instanceId);
      continue;
    }

    const instance = buildArchiveInstanceFromLastStopSession(session);
    if (!instance) {
      skipped.push(session.instanceId);
      continue;
    }

    try {
      await deps.archiveInstance(instance);
      ingestedThreads.add(historyThreadId);
      ingested.push(session.instanceId);
    } catch (error) {
      failed.push({
        instanceId: session.instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ingested, skipped, failed };
}
