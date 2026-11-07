import type { UserActionRequest } from '../orchestration/orchestration-handler.types';
import { presentInstanceStatus } from '../../shared/attention/instance-status-presentation';
import { userActionNotificationTitle } from './user-action-notification';

/** "Needs your OK" becomes "needs your OK", so the alert reads "Fix login needs your OK". */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * The alert title for a request: the session's name, then the same two status
 * words the sidebar and the phone use (`Needs your answer`, `Needs your OK`).
 */
export function userActionNoticeTitle(request: Pick<UserActionRequest, 'requestType' | 'targetMode'>, sessionName?: string): string {
  const session = sessionName?.trim() || 'A session';
  if (request.requestType === 'switch_mode' && request.targetMode) {
    const mode = request.targetMode[0].toUpperCase() + request.targetMode.slice(1);
    return `${session} ${lowerFirst(userActionNotificationTitle('approve_action'))} to switch to ${mode} mode`;
  }
  return `${session} ${lowerFirst(userActionNotificationTitle(request.requestType === 'switch_mode' ? 'approve_action' : request.requestType))}`;
}

export function inputRequiredNotice(sessionName: string | undefined, metadata?: Record<string, unknown>): { title: string; body: string } {
  const session = sessionName?.trim() || 'A session';
  const type = metadata?.['type'];
  if (type === 'ask_user_question' || type === 'mcp_elicitation') {
    return { title: `${session} ${lowerFirst(presentInstanceStatus('waiting_for_input').label)}`, body: '' };
  }
  if (type === 'permission_denial' || type === 'deferred_permission' || type === 'acp_permission_request') {
    const rawTool = type === 'acp_permission_request' ? metadata?.['toolName'] : metadata?.['tool_name'];
    // Metadata is not a trusted display string. Reject command text, paths and unbounded labels.
    const tool = typeof rawTool === 'string' && /^[a-zA-Z][\w.:-]{0,79}$/.test(rawTool) ? rawTool : '';
    return { title: `${session} ${lowerFirst(presentInstanceStatus('waiting_for_permission').label)}`, body: tool ? `Wants to use ${tool}` : '' };
  }
  return { title: `${session} needs you`, body: '' };
}
