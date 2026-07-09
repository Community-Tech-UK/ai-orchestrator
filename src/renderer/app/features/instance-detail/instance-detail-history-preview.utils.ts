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

function shortenPath(path: string): string {
  return path
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~');
}
