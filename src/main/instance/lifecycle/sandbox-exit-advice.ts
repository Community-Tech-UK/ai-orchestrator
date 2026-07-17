/**
 * WS13 slice 3 — sandbox-denial surfacing at the unexpected-exit seam.
 *
 * When a HARDENED instance dies, classify the exit with the codex denial
 * heuristic over recent output so the user sees "the sandbox blocked this"
 * plus the allow-and-retry lever instead of a cryptic exit code. Fail-closed
 * stays intact: any respawn re-enters the same jail via the factory registry —
 * never an unsandboxed retry.
 */

import { getNotificationService } from '../../notifications/notification-service';
import { buildSandboxExitAdvice } from '../../sandbox/seatbelt';
import { isInstanceHardened } from './hardened-mode-scoping';
import type { OutputMessage } from '../../../shared/types/instance.types';

/**
 * Returns the advice suffix for the crash error ('' when not a hardened
 * denial) and raises a deduped notification when it is one.
 */
export function noteSandboxDenialOnExit(
  instanceId: string,
  exitCode: number | null,
  recentMessages: readonly OutputMessage[],
): string {
  const advice = buildSandboxExitAdvice({
    hardened: isInstanceHardened(instanceId),
    exitCode,
    recentOutput: recentMessages.slice(-5).map((m) => m.content).join('\n'),
  });
  if (!advice) return '';
  try {
    getNotificationService().notify({
      kind: 'sandbox-denial',
      instanceId,
      title: 'Hardened mode blocked the session',
      body: 'The Seatbelt sandbox likely denied a file write and the CLI exited. Grant the blocked path ("Allow path & retry") or recreate without hardened mode.',
      fingerprintFields: { instanceId },
    });
  } catch { /* notification is best-effort */ }
  return advice;
}
