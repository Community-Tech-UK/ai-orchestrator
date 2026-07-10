import type { InstanceProvider, OutputMessage } from '../../core/state/instance.store';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';

export function providerDisplayName(provider: string): string {
  switch (provider) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'ollama':
      return 'Ollama';
    case 'copilot':
      return 'Copilot';
    case 'cursor':
      return 'Cursor';
    case 'grok':
      return 'Grok';
    default:
      return 'AI';
  }
}

export function shouldShowWakeupReviveToggle(status: string): boolean {
  return status === 'failed'
    || status === 'error'
    || status === 'terminated'
    || status === 'cancelled'
    || status === 'superseded'
    || status === 'hibernated';
}

export function getHistoryPreviewInstanceId(entryId: string): string {
  return `history-preview:${entryId}`;
}

export function getHistoryPreviewSubtitle(
  entry: ConversationHistoryEntry,
  provider: InstanceProvider,
): string {
  const path = entry.workingDirectory.trim() || 'No workspace';
  return `${providerDisplayName(provider)} history - ${shortenPath(path)}`;
}

export function buildHistoryPreviewPendingRestoreMessages(
  entryId: string,
  message: string,
): { id: string; messages: OutputMessage[] } {
  const id = `history-preview-queued-${entryId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const timestamp = Date.now();
  return {
    id,
    messages: [
      {
        id: `${id}-user`,
        timestamp,
        type: 'user',
        content: message,
        metadata: {
          historyPreviewQueued: true,
        },
      },
      {
        id: `${id}-notice`,
        timestamp: timestamp + 1,
        type: 'system',
        content: 'Restoring this session. Your message will send when the session is ready.',
        metadata: {
          isRestoreNotice: true,
          systemMessageKind: 'history-preview-restore-queue',
        },
      },
    ],
  };
}

/**
 * Pure reducer: append a pending-restore user+notice message pair for `entryId`.
 * Returns the generated id and the next map (does not mutate `current`).
 */
export function appendHistoryPreviewPendingRestore(
  current: Record<string, OutputMessage[]>,
  entryId: string,
  message: string,
): { id: string; next: Record<string, OutputMessage[]> } {
  const { id, messages } = buildHistoryPreviewPendingRestoreMessages(entryId, message);
  return {
    id,
    next: { ...current, [entryId]: [...(current[entryId] ?? []), ...messages] },
  };
}

/**
 * Pure reducer: remove the pending-restore messages for `id` under `entryId`,
 * dropping the entry key entirely when it becomes empty.
 */
export function removeHistoryPreviewPendingRestore(
  current: Record<string, OutputMessage[]>,
  entryId: string,
  id: string,
): Record<string, OutputMessage[]> {
  const nextMessages = (current[entryId] ?? []).filter(
    (message) => !message.id.startsWith(`${id}-`)
  );

  if (nextMessages.length === 0) {
    const next = { ...current };
    delete next[entryId];
    return next;
  }

  return {
    ...current,
    [entryId]: nextMessages,
  };
}

function shortenPath(path: string): string {
  return path
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~');
}
