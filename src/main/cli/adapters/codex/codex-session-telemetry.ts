import type { SessionThreadCreditsRecord, SessionTurnShareRecord } from '../../../core/system/session-policy-log';
import { recordSessionThreadCredits, recordSessionTurnShare } from '../../../core/system/session-policy-log';
import { getLogger } from '../../../logging/logger';
import { errorDiagnostic } from '../../../logging/source-diagnostics';

/**
 * Session-policy telemetry for a Codex round and for a thread's credits (Oct-2 Phase D Steps 2.3 and 11.1).
 * The Electron main process owns the log, and an adapter running there writes it directly. The record is also
 * emitted as an adapter event; nothing forwards it from a remote worker node yet, so a remote session writes no row.
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

export function publishSessionThreadCredits(adapter: Emitter, record: SessionThreadCreditsRecord): void {
  publish(adapter, SESSION_THREAD_CREDITS_EVENT, record, () => recordSessionThreadCredits(record));
}
