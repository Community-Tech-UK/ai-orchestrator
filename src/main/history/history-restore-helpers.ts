import type { ConversationHistoryEntry } from '../../shared/types/history.types';
import type { InstanceProvider, OutputMessage } from '../../shared/types/instance.types';

const SESSION_NOT_FOUND_MESSAGE = /no conversation found|session.*not.*found/i;
const SESSION_NOT_FOUND_ID_MESSAGE = /session\s+id:\s*([^\s]+)/i;
const UUID_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESTORE_FALLBACK_NOTICE_MESSAGE = /^Previous .+ CLI session could not be restored natively\./;

/**
 * Select the most recent messages within a count limit for display during restore.
 * Keeps tool_use/tool_result pairs together at the boundary.
 */
export function selectMessagesForRestore(
  messages: OutputMessage[],
  limit = 100,
): { selected: OutputMessage[]; hidden: OutputMessage[]; truncatedCount: number } {
  if (!messages?.length || messages.length <= limit) {
    return { selected: messages || [], hidden: [], truncatedCount: 0 };
  }

  let startIdx = messages.length - limit;

  while (startIdx > 0 && messages[startIdx]?.type === 'tool_result') {
    startIdx--;
  }

  return {
    hidden: messages.slice(0, startIdx),
    selected: messages.slice(startIdx),
    truncatedCount: startIdx,
  };
}

export function isRestoreInfrastructureMessage(message: OutputMessage): boolean {
  const kind = message.metadata?.['systemMessageKind'];
  if (message.metadata?.['isRestoreNotice'] === true || kind === 'restore-fallback') {
    return true;
  }

  if (message.type === 'system' && RESTORE_FALLBACK_NOTICE_MESSAGE.test(message.content.trim())) {
    return true;
  }

  return message.type === 'error' && SESSION_NOT_FOUND_MESSAGE.test(message.content);
}

export function getMessagesForRestoreTranscript(messages: OutputMessage[]): OutputMessage[] {
  return (messages || []).filter((message) => !isRestoreInfrastructureMessage(message));
}

function normalizeSessionId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function getFailedResumeSessionIds(messages: OutputMessage[]): Set<string> {
  const failedSessionIds = new Set<string>();
  for (const message of messages || []) {
    if (message.type === 'error' && SESSION_NOT_FOUND_MESSAGE.test(message.content)) {
      const failedId = message.content.match(SESSION_NOT_FOUND_ID_MESSAGE)?.[1];
      if (failedId?.trim()) {
        failedSessionIds.add(failedId.trim());
      }
    }

    const originalSessionId = message.metadata?.['originalSessionId'];
    if (isRestoreInfrastructureMessage(message) && typeof originalSessionId === 'string') {
      const normalized = normalizeSessionId(originalSessionId);
      if (normalized) {
        failedSessionIds.add(normalized);
      }
    }
  }

  return failedSessionIds;
}

export function getNativeResumeSessionId(
  entry: Pick<ConversationHistoryEntry, 'sessionId' | 'historyThreadId' | 'nativeResumeFailedAt'>,
  messages: OutputMessage[],
  provider: InstanceProvider,
): string | undefined {
  const sessionId = normalizeSessionId(entry.sessionId);
  const historyThreadId = normalizeSessionId(entry.historyThreadId);

  if (entry.nativeResumeFailedAt == null) {
    return sessionId || historyThreadId;
  }

  if (!historyThreadId || historyThreadId === sessionId) {
    return undefined;
  }

  if (provider !== 'claude' || !UUID_SESSION_ID.test(historyThreadId)) {
    return undefined;
  }

  const failedSessionIds = getFailedResumeSessionIds(messages);
  return failedSessionIds.has(historyThreadId) ? undefined : historyThreadId;
}

export function getOriginalSessionIdFromRestoreNotices(messages: OutputMessage[]): string | undefined {
  for (const message of messages || []) {
    if (!isRestoreInfrastructureMessage(message)) {
      continue;
    }

    const originalSessionId = message.metadata?.['originalSessionId'];
    if (typeof originalSessionId === 'string' && originalSessionId.trim()) {
      return originalSessionId.trim();
    }
  }

  return undefined;
}

export function getProviderDisplayName(provider: InstanceProvider): string {
  switch (provider) {
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'copilot':
      return 'Copilot';
    case 'cursor':
      return 'Cursor';
    case 'claude':
    default:
      return 'Claude';
  }
}
