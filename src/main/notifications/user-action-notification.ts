/**
 * The desktop notification for an agent that is waiting on a person.
 *
 * It uses the same two words as the session's status, so the alert, the sidebar
 * dot and the phone agree: a question "Needs your answer", a request for
 * permission or confirmation "Needs your OK". (It used to read "Questions from
 * AI Instance", "Approval Needed" and "Input Needed".)
 */

import { presentInstanceStatus } from '../../shared/attention/instance-status-presentation';

/** Body used when the request carries no message of its own. */
export const USER_ACTION_DEFAULT_BODY = 'A session is waiting for your response.';

const OK_REQUEST_TYPES: ReadonlySet<string> = new Set(['approve_action', 'confirm']);

export function userActionNotificationTitle(requestType: string | undefined, targetMode?: string): string {
  const needsOk = presentInstanceStatus('waiting_for_permission').label;
  if (requestType === 'switch_mode') {
    const mode = targetMode ? `${targetMode.charAt(0).toUpperCase()}${targetMode.slice(1)}` : 'requested';
    return `${needsOk}: switch to ${mode} mode`;
  }
  if (requestType && OK_REQUEST_TYPES.has(requestType)) return needsOk;
  return presentInstanceStatus('waiting_for_input').label;
}
