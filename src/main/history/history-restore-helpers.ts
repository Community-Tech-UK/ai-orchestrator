import type { ConversationHistoryEntry } from '../../shared/types/history.types';
import type { InstanceProvider, OutputMessage } from '../../shared/types/instance.types';
import { LEGACY_ACCOUNT_PROFILE_ID } from '../../shared/types/provider-account.types';
import { isToolOutcomeMessage } from '../../shared/types/tool-outcome';
import { isSessionNotFoundText } from '../cli/adapters/resume-error-classifier';
import { isLegacyRedactedToolOutput } from '../session/redacted-tool-output';
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

  return message.type === 'error' && isSessionNotFoundText(message.content);
}

/**
 * The archived messages a restored instance may show and replay. Excludes the
 * LT-196 `tool_outcome` record: it is held out of `outputBuffer` by design (see
 * `tool-outcome-store.ts`), so restore re-seeds the side store instead of
 * seeding the buffer with it.
 */
export function getMessagesForRestoreTranscript(messages: OutputMessage[]): OutputMessage[] {
  return (messages || []).filter(
    (message) =>
      !isToolOutcomeMessage(message)
      && !isRestoreInfrastructureMessage(message)
      && !isLegacyRedactedToolOutput(message.content),
  );
}

function normalizeSessionId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/**
 * A native resume only works in the account whose CLI home holds that session.
 * Choosing a different account replays the transcript there instead.
 * No choice keeps today's behaviour: native resume pins the stored account,
 * and a replay restore lets the pool route.
 */
export function resolveRestoreAccount(params: {
  storedAccountProfileId?: string;
  requestedAccountProfileId?: string;
}): {
  nativeAccountProfileId?: string;
  explicitAccountProfileId?: string;
  forceReplay: boolean;
} {
  const requested = params.requestedAccountProfileId?.trim();
  if (!requested) {
    return {
      nativeAccountProfileId: params.storedAccountProfileId,
      forceReplay: false,
    };
  }
  const stored = params.storedAccountProfileId ?? LEGACY_ACCOUNT_PROFILE_ID;
  return {
    nativeAccountProfileId: requested,
    explicitAccountProfileId: requested,
    forceReplay: requested !== stored,
  };
}

export function getNativeResumeSessionId(
  entry: Pick<ConversationHistoryEntry, 'sessionId' | 'nativeResumeFailedAt'>,
): string | undefined {
  const sessionId = normalizeSessionId(entry.sessionId);
  return entry.nativeResumeFailedAt == null ? sessionId : undefined;
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
    case 'antigravity':
      return 'Antigravity';
    case 'copilot':
      return 'Copilot';
    case 'cursor':
      return 'Cursor';
    case 'claude':
    default:
      return 'Claude';
  }
}
