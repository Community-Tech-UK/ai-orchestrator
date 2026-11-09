import type { AutomationRunStatus } from '../types/automation.types';
import type { UserMessage } from './user-message';

/** Stored errors are classifier inputs. Translate them without rewriting the record. */
const FAILURE_COPY = {
  'Instance entered error': { text: 'The session failed.', next: 'Open the session to see what happened, then try again.' },
  'Instance entered failed': { text: 'The session failed.', next: 'Open the session to see what happened, then try again.' },
  'Instance entered terminated': { text: 'The session closed before the run finished.', next: 'Run the automation again when you are ready.' },
  'Instance entered cancelled': { text: 'The session stopped before the run finished.', next: 'Run the automation again when you are ready.' },
  'Instance entered superseded': { text: 'The session was replaced before the run finished.', next: 'Check the replacement session before running the automation again.' },
  'Automation requires unattended permission approval': { text: 'The automation stopped because it needs your approval.', next: 'Open the session to review the request.' },
  'Automation requires unattended user input': { text: 'The automation stopped because it needs your answer.', next: 'Open the session to answer the question.' },
  'Automation could not report its result': { text: 'The automation finished, but its report to Harness was refused.', next: 'Open the session to see what it found and why the report was refused.' },
  'Automation instance was removed': { text: 'The session was removed before the run finished.', next: 'Run the automation again when you are ready.' },
  'App restarted before automation run completed': { text: 'Harness restarted before the run finished.', next: 'Check the work already done before running the automation again.' },
} satisfies Record<string, Omit<UserMessage, 'detail'>>;

export function presentAutomationFailure(raw: string): UserMessage {
  const copy = Object.hasOwn(FAILURE_COPY, raw) ? FAILURE_COPY[raw as keyof typeof FAILURE_COPY] : undefined;
  return { ...(copy ?? { text: 'Something went wrong.' }), detail: raw };
}

const RUN_STATUS_COPY: Record<AutomationRunStatus, string> = {
  running: 'Running', pending: 'Waiting', failed: 'Failed', succeeded: 'Done', skipped: 'Skipped', cancelled: 'Cancelled',
};

export function automationRunStatusLabel(status: AutomationRunStatus): string {
  return RUN_STATUS_COPY[status];
}
