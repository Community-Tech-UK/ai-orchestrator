/**
 * A15 / 8b item 9 — default-deny for who may set a check command.
 *
 * A pre-check is a shell command Harness runs on a schedule, on this Mac,
 * outside the sandbox. Only the Automations page may set one. Every create
 * caller that does not say otherwise counts as an agent and is refused; an
 * agent's `update_automation` also cannot move a checked job to another folder
 * (a relative check command would then run from a folder the agent chose) or
 * change the check itself.
 */

import type { Automation, AutomationAction, UpdateAutomationInput } from '../../shared/types/automation.types';

export type AutomationCheckOrigin = 'automations-page' | 'agent';

export function assertCheckOriginAllowed(action: AutomationAction, origin: AutomationCheckOrigin): void {
  if (action.preCheck && origin !== 'automations-page') {
    throw new Error('A check command can only be added on the Automations page.');
  }
}

export function assertCheckedJobStays(existing: Automation, updates: UpdateAutomationInput): void {
  const nextDirectory = updates.action?.workingDirectory;
  const nextCheck = updates.action?.preCheck;
  const existingCheck = existing.action.preCheck;

  if (nextCheck && !existingCheck) {
    throw new Error('A check command can only be added on the Automations page.');
  }
  if (!existingCheck) {
    return;
  }
  if (nextDirectory && nextDirectory !== existing.action.workingDirectory) {
    throw new Error(
      'A job with a check cannot be moved to another folder from here — its check command would run there. Edit it on the Automations page.',
    );
  }
  if (nextCheck) {
    const sameCommand = nextCheck.command === existingCheck.command;
    const sameOnError = (nextCheck.onError ?? 'run-anyway') === (existingCheck.onError ?? 'run-anyway');
    if (!sameCommand || !sameOnError) {
      throw new Error('A check command can only be changed on the Automations page.');
    }
  }
}
