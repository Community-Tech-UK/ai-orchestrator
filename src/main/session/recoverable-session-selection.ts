import type { RecoverableSession } from './last-stop-snapshot';

export interface RecoverableSessionSelectionInput extends RecoverableSession {
  historyThreadId?: string;
  recoveryKey: string;
  lastActivityAt: number;
  isLive: boolean;
  messageCount: number;
  hasAssistantOutput: boolean;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function isRecoverable(session: RecoverableSessionSelectionInput): boolean {
  if (session.provider?.trim().toLowerCase() === 'gemini') return false;
  const hasNativeResumeIdentity = nonEmpty(session.sessionId) !== null
    || (session.resumeCursor !== null && session.resumeCursor !== undefined);
  return hasNativeResumeIdentity;
}

/**
 * Build the stable, provider-scoped identity used to collapse session
 * generations. This is deliberately pure so snapshot writing and startup
 * recovery can apply identical identity rules without an InstanceManager.
 */
export function getCanonicalRecoveryKey(
  session: Pick<RecoverableSessionSelectionInput,
    'instanceId' | 'provider' | 'historyThreadId' | 'resumeCursor' | 'sessionId'>,
): string {
  const provider = nonEmpty(session.provider)
    ?? nonEmpty(session.resumeCursor?.provider)
    ?? 'unknown';
  const historyThreadId = nonEmpty(session.historyThreadId);
  if (historyThreadId) return `history:${provider}:${historyThreadId}`;

  const cursorThreadId = nonEmpty(session.resumeCursor?.threadId);
  if (cursorThreadId) return `cursor:${provider}:${cursorThreadId}`;

  const providerSessionId = nonEmpty(session.sessionId);
  if (providerSessionId) return `session:${provider}:${providerSessionId}`;

  return `instance:${session.instanceId}`;
}

function compareSessions(
  left: RecoverableSessionSelectionInput,
  right: RecoverableSessionSelectionInput,
): number {
  if (left.isLive !== right.isLive) return left.isLive ? -1 : 1;

  const byActivity = right.lastActivityAt - left.lastActivityAt;
  if (byActivity !== 0) return byActivity;

  const byKey = left.recoveryKey.localeCompare(right.recoveryKey);
  if (byKey !== 0) return byKey;

  const byInstance = left.instanceId.localeCompare(right.instanceId);
  if (byInstance !== 0) return byInstance;

  return right.capturedAt - left.capturedAt;
}

/**
 * Return one deterministic current generation per canonical recovery key.
 * Live sessions are never displaced by the bounded non-live fallback set.
 */
export function selectRecoverableSessions(
  sessions: readonly RecoverableSessionSelectionInput[],
  nonLiveLimit = 20,
): RecoverableSessionSelectionInput[] {
  const bestByRecoveryKey = new Map<string, RecoverableSessionSelectionInput>();

  for (const session of sessions) {
    if (!isRecoverable(session)) continue;
    const existing = bestByRecoveryKey.get(session.recoveryKey);
    if (!existing || compareSessions(session, existing) < 0) {
      bestByRecoveryKey.set(session.recoveryKey, session);
    }
  }

  const selected = Array.from(bestByRecoveryKey.values()).sort(compareSessions);
  const limit = Number.isFinite(nonLiveLimit)
    ? Math.max(0, Math.floor(nonLiveLimit))
    : 20;
  const live = selected.filter((session) => session.isLive);
  const nonLive = selected.filter((session) => !session.isLive).slice(0, limit);

  return [...live, ...nonLive];
}
