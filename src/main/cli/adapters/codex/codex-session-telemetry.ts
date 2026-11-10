import type { SessionThreadCreditsRecord, SessionTurnShareRecord } from '../../../core/system/session-policy-log';
import { recordSessionThreadCredits, recordSessionTurnShare } from '../../../core/system/session-policy-log';
import type { UnifiedSpawnOptions } from '../adapter-factory.types';
import { getLogger } from '../../../logging/logger';
import { errorDiagnostic } from '../../../logging/source-diagnostics';

/**
 * Session-policy telemetry for a Codex round and for a thread's credits (Oct-2 Phase D Steps 2.3 and 11.1).
 * The Electron main process owns the log, and an adapter running there writes it directly. The record is also
 * emitted as an adapter event. A remote worker has no log, so a round's share is forwarded over instance telemetry
 * and `RemoteCliAdapter` writes the row on the controller; a thread's credits are not forwarded yet, so a remote
 * session writes no credits row.
 * Telemetry must never break a turn or a shutdown, so neither step may throw.
 */
const SESSION_TURN_SHARE_EVENT = 'session_turn_share';
const SESSION_THREAD_CREDITS_EVENT = 'session_thread_credits';

const logger = getLogger('CodexSessionTelemetry');

interface Emitter { emit(event: string, ...args: unknown[]): boolean }

function publish(adapter: Emitter, event: string, record: unknown, write: () => void): void {
  try {
    write();
    adapter.emit(event, record);
  } catch (error) {
    logger.warn('Could not publish session-policy telemetry', { event, ...errorDiagnostic(error) });
  }
}

export function publishSessionTurnShare(adapter: Emitter, record: SessionTurnShareRecord): void {
  publish(adapter, SESSION_TURN_SHARE_EVENT, record, () => recordSessionTurnShare(record));
}

/**
 * A round's share forwarded from a remote worker, which has no log. The row is written here and labelled from this
 * controller's own spawn options, so a worker cannot label a row as another session's or arm's.
 */
export function publishRemoteTurnShare(
  adapter: Emitter,
  payload: Omit<SessionTurnShareRecord, 'event' | 'provider' | 'sessionKind' | 'instanceId' | 'arm' | 'armKey' | 'armSource'>,
  spawn: Pick<UnifiedSpawnOptions, 'instanceId' | 'sessionKind' | 'trialArm' | 'trialKey' | 'trialKeySource'>,
): void {
  publishSessionTurnShare(adapter, {
    ...payload, event: 'turn-share', provider: 'codex', sessionKind: spawn.sessionKind ?? 'chat',
    ...(spawn.instanceId ? { instanceId: spawn.instanceId } : {}), ...(spawn.trialArm ? { arm: spawn.trialArm } : {}),
    ...(spawn.trialKey ? { armKey: spawn.trialKey } : {}), ...(spawn.trialKeySource ? { armSource: spawn.trialKeySource } : {}),
  });
}

export function publishSessionThreadCredits(adapter: Emitter, record: SessionThreadCreditsRecord): void {
  publish(adapter, SESSION_THREAD_CREDITS_EVENT, record, () => recordSessionThreadCredits(record));
}
