import type { InstanceStatus } from '../types/instance.types';
import { presentInstanceStatus } from '../attention/instance-status-presentation';

export interface UserMessage {
  text: string;
  next?: string;
  detail?: string;
}

/** Diagnostic detail belongs in a disclosure, never in the primary sentence. */
export function renderUserMessage(message: UserMessage): string {
  return [message.text, message.next].filter(Boolean).join(' ');
}

/** Keep the raw error for retry classification and metadata.detail at the call site. */
export function presentSendFailure(raw: string, code?: string): string {
  if (code === 'ORCHESTRATOR_PAUSED' || /(?:orchestrator|harness) is paused/i.test(raw)) {
    return 'Harness is paused, so nothing was sent. Resume Harness, then send again.';
  }
  const timeout = /send input timed out after ([\d.]+s)/i.exec(raw);
  if (timeout) {
    return `Your message didn't reach the session within ${timeout[1]}. Check the session is running, then send it again.`;
  }
  return "Your message wasn't sent.";
}

export function sendRefusedText(action: 'send' | 'steer' | 'steer-queued', status: InstanceStatus): string {
  const label = presentInstanceStatus(status).label.toLowerCase();
  const state = status === 'superseded' ? 'has been replaced' : status === 'cancelled' ? 'was stopped'
    : status === 'terminated' ? 'has closed' : status === 'failed' || status === 'error' ? 'has failed' : `is ${label}`;
  const subject = action === 'steer-queued' ? 'your queued message' : 'your message';
  return `This session ${state}, so ${subject} wasn't sent. Restart the session to continue.`;
}
