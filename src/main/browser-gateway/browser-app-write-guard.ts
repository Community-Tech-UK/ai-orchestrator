/**
 * Guard around app-state mutations on shared existing tabs (reliability
 * hardening, 2026-07-17): pre-write session validation after a channel
 * disconnect, post-write app-signal scan, and write-journal bookkeeping.
 *
 * Split out of BrowserExistingTabOperations so the guard sequencing is
 * independently testable and the operations file stays within size limits.
 */

import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type { BrowserReliabilityEvents } from './browser-reliability-events';
import {
  persistenceFailureError,
  type BrowserSentinelSendCommand,
  type BrowserTargetPersistenceScan,
  type BrowserTargetPersistenceSentinel,
} from './browser-target-persistence-sentinel';
import type { BrowserWriteJournal, BrowserWriteOutcome } from './browser-write-journal';

export interface AppWriteGuardDeps {
  sentinel: Pick<BrowserTargetPersistenceSentinel, 'scan' | 'needsPreWriteCheck'>;
  rawSendCommand: BrowserSentinelSendCommand;
  writeJournal?: Pick<BrowserWriteJournal, 'recordIntent' | 'recordOutcome'>;
  getLastChannelDisconnectAt?: (nodeId: string | undefined) => number | undefined;
  reliabilityEvents?: Pick<BrowserReliabilityEvents, 'record'>;
}

/**
 * Run one app-state mutation under the persistence guard:
 * 1. Pre-write gate — after a channel disconnect the target's in-page session
 *    may be dead while the DOM still accepts input. Verify BEFORE firing the
 *    first post-disconnect write; refuse rather than fire into a stale
 *    session (no blind writes, no blind retries).
 * 2. Dispatch via the provided thunk.
 * 3. Post-write scan — the dispatch succeeded, but the APP may have rejected
 *    the save (the silent-loss failure mode). Never report a dropped write as
 *    success.
 */
export async function guardAppStateMutation(
  deps: AppWriteGuardDeps,
  attachment: BrowserExistingTabAttachment,
  command: string,
  payload: Record<string, unknown> | undefined,
  dispatch: () => Promise<unknown>,
): Promise<unknown> {
  const lastDisconnectAt = deps.getLastChannelDisconnectAt?.(attachment.nodeId);
  if (deps.sentinel.needsPreWriteCheck(attachment, lastDisconnectAt)) {
    const preScan = await deps.sentinel.scan(attachment, deps.rawSendCommand);
    if (preScan.state === 'save_failed' || preScan.state === 'session_stale') {
      recordWriteRejection(deps, attachment, preScan);
      throw persistenceFailureError(preScan.state, 'pre_write', preScan.matchedPattern);
    }
  }

  const journalSeq = await recordWriteIntent(deps, attachment, command, payload);
  let result: unknown;
  try {
    result = await dispatch();
  } catch (error) {
    recordWriteOutcome(deps, attachment, journalSeq, writeOutcomeFromError(error), {
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const scan = await deps.sentinel.scan(attachment, deps.rawSendCommand);
  recordWriteOutcome(deps, attachment, journalSeq, 'succeeded', { scan });
  if (scan.state === 'save_failed' || scan.state === 'session_stale') {
    recordWriteRejection(deps, attachment, scan);
    throw persistenceFailureError(scan.state, 'post_write', scan.matchedPattern);
  }
  return result;
}

async function recordWriteIntent(
  deps: AppWriteGuardDeps,
  attachment: BrowserExistingTabAttachment,
  command: string,
  payload: Record<string, unknown> | undefined,
): Promise<number | null> {
  try {
    return await deps.writeJournal?.recordIntent({
      profileId: attachment.profileId,
      targetId: attachment.targetId,
      command,
      ...(payload ? { payload } : {}),
    }) ?? null;
  } catch {
    return null;
  }
}

function recordWriteOutcome(
  deps: AppWriteGuardDeps,
  attachment: BrowserExistingTabAttachment,
  seq: number | null,
  outcome: Exclude<BrowserWriteOutcome, 'pending'>,
  extras: { scan?: BrowserTargetPersistenceScan; reason?: string } = {},
): void {
  if (seq === null) {
    return;
  }
  void deps.writeJournal?.recordOutcome({
    profileId: attachment.profileId,
    targetId: attachment.targetId,
    seq,
    outcome,
    ...(extras.scan ? { scan: extras.scan } : {}),
    ...(extras.reason ? { reason: extras.reason.slice(0, 300) } : {}),
  }).catch(() => undefined);
}

function recordWriteRejection(
  deps: AppWriteGuardDeps,
  attachment: BrowserExistingTabAttachment,
  scan: BrowserTargetPersistenceScan,
): void {
  deps.reliabilityEvents?.record(
    scan.state === 'session_stale'
      ? 'write_rejected_session_stale'
      : 'write_rejected_save_failed',
    {
      ...(attachment.nodeId ? { nodeId: attachment.nodeId } : {}),
      detail: {
        origin: attachment.origin,
        ...(scan.matchedPattern ? { matchedPattern: scan.matchedPattern } : {}),
      },
    },
  );
}

/**
 * Journal outcome for a failed dispatch, mirroring the channel-error taxonomy:
 * not_delivered / receipt_missing / probe-confirmed-not-applied certainly did
 * not apply; a delivered timeout (or probe-confirmed apply) may have.
 */
function writeOutcomeFromError(error: unknown): 'failed' | 'maybe_applied' {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('timed_out_applied')) {
    return 'maybe_applied';
  }
  if (
    message.includes('not_delivered')
    || message.includes('receipt_missing')
    || message.includes('timed_out_not_applied')
  ) {
    return 'failed';
  }
  if (
    message.startsWith('browser_extension_command_timeout')
    || message.startsWith('browser_extension_channel_down')
  ) {
    return 'maybe_applied';
  }
  return 'failed';
}
