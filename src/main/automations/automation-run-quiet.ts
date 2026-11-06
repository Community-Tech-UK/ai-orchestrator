/**
 * A15 / 8c — quiet replies for scheduled runs.
 *
 * When a scheduled run's AI has nothing to tell James, it ends its final reply
 * with the sentinel `[[HARNESS:QUIET_RUN]]` on its own last line. The run is
 * then filed as quiet (`outcome: 'quiet'`), does not raise the unread badge,
 * and its full reply is still kept with the run. The sentinel is taught once
 * per session by {@link appendQuietReplyContract}, appended after the job's
 * own prompt so his prompt's prefix is unchanged.
 */

import type { AutomationTrigger } from '../../shared/types/automation.types';

export const QUIET_RUN_SENTINEL = '[[HARNESS:QUIET_RUN]]';

const QUIET_RUN_CONTRACT = `<harness_run_contract>
Harness started this session on a schedule. When your work is finished and nothing needs James's attention, make the last line of your final reply exactly:
${QUIET_RUN_SENTINEL}
Harness then files the run as quiet and keeps your full reply with the run. Use that line only as the final line of your final reply.
Example final reply for a run with nothing new:
The leads panel returned 200 and the newest lead arrived at 08:40, so there is nothing to tell James.
${QUIET_RUN_SENTINEL}
</harness_run_contract>`;

/**
 * Append the quiet-reply contract for scheduled/catch-up runs that start a
 * fresh session. Thread wake-ups and loops are untouched (the caller only
 * reaches this from the two `createInstance` sites), and manual/webhook runs
 * never quiet-reply.
 */
export function appendQuietReplyContract(
  prompt: string,
  trigger: AutomationTrigger,
): string {
  if (trigger !== 'scheduled' && trigger !== 'catchUp') {
    return prompt;
  }
  return `${prompt}\n\n${QUIET_RUN_CONTRACT}`;
}

/** True only when the last non-empty line is exactly the sentinel. */
export function isQuietReply(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.length > 0 && lines[lines.length - 1] === QUIET_RUN_SENTINEL;
}

/** The reply with the sentinel line removed (what the run keeps as its summary). */
export function stripQuietSentinel(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]!.trim().length === 0) {
      continue;
    }
    if (lines[i]!.trim() === QUIET_RUN_SENTINEL) {
      lines.splice(i, 1);
    }
    break;
  }
  return lines.join('\n').trim();
}
