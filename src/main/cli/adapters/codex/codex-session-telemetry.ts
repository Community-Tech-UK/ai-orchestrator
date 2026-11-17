import type { SessionThreadCreditsRecord, SessionTurnShareRecord } from '../../../core/system/session-policy-log';
import { recordSessionThreadCredits, recordSessionTurnShare } from '../../../core/system/session-policy-log';
import type { InstanceTelemetry } from '../../../remote-node/instance-telemetry-rpc';
import type { UnifiedSpawnOptions } from '../adapter-factory.types';
import { getLogger } from '../../../logging/logger';
import { errorDiagnostic } from '../../../logging/source-diagnostics';

/**
 * Session-policy telemetry for a Codex round and for a thread's credits (Oct-2 Phase D Steps 2.3 and 11.1).
 * The Electron main process owns the log, and an adapter running there writes it directly. The record is also
 * emitted as an adapter event. A remote worker has no log, so a round's share is forwarded over instance telemetry
 * and a thread's credits as `session_thread_credits`, and `RemoteCliAdapter` writes both rows on the controller.
 * The worker reads credits as the session ends or its thread is replaced, and sends them before it answers the
 * terminate call, so the controller still listens when they arrive.
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

/** Spawn labels the controller puts on every row, so a worker cannot label a row as someone else's. */
type SpawnLabels = Pick<UnifiedSpawnOptions, 'instanceId' | 'sessionKind' | 'trialArm' | 'trialKey' | 'trialKeySource'>;
const spawnLabels = (spawn: SpawnLabels) => ({
  sessionKind: spawn.sessionKind ?? 'chat',
  ...(spawn.instanceId ? { instanceId: spawn.instanceId } : {}), ...(spawn.trialArm ? { arm: spawn.trialArm } : {}),
  ...(spawn.trialKey ? { armKey: spawn.trialKey } : {}), ...(spawn.trialKeySource ? { armSource: spawn.trialKeySource } : {}),
});

/**
 * A round's share forwarded from a remote worker, which has no log. The row is written here and labelled from this
 * controller's own spawn options, so a worker cannot label a row as another session's or arm's.
 */
export function publishRemoteTurnShare(
  adapter: Emitter,
  payload: Omit<SessionTurnShareRecord, 'event' | 'provider' | 'sessionKind' | 'instanceId' | 'arm' | 'armKey' | 'armSource'>,
  spawn: SpawnLabels,
): void {
  publishSessionTurnShare(adapter, { ...payload, event: 'turn-share', provider: 'codex', ...spawnLabels(spawn) });
}

export function publishSessionThreadCredits(adapter: Emitter, record: SessionThreadCreditsRecord): void {
  publish(adapter, SESSION_THREAD_CREDITS_EVENT, record, () => recordSessionThreadCredits(record));
}

/** A thread's credits forwarded from a remote worker, written here under the controller's own labels. */
export function publishRemoteThreadCredits(
  adapter: Emitter,
  payload: Omit<SessionThreadCreditsRecord, 'event' | 'provider' | 'sessionKind' | 'instanceId' | 'arm' | 'armKey' | 'armSource'>,
  spawn: SpawnLabels,
): void {
  publishSessionThreadCredits(adapter, { ...payload, event: 'thread-credits', provider: 'codex', ...spawnLabels(spawn) });
}

/** Handles the worker telemetry that becomes a session-policy row on this side; false means it is not one of those. */
export function publishRemoteCodexTelemetry(adapter: Emitter, telemetry: InstanceTelemetry, spawn: SpawnLabels): boolean {
  if (telemetry.event === 'session_turn_share') publishRemoteTurnShare(adapter, telemetry.payload, spawn);
  else if (telemetry.event === 'session_thread_credits') publishRemoteThreadCredits(adapter, telemetry.payload, spawn);
  else return false;
  return true;
}
