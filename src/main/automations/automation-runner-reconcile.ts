import type { Instance } from '../../shared/types/instance.types';
import type { AutomationResult } from '@contracts/schemas/automation';
import { isVisibleOutputMessage } from '../../shared/types/tool-outcome';
import { FAILURE_STATUSES, WAIT_STATUSES } from './automation-runner-snapshots';
import type { RunTracking } from './automation-runner-helpers';
import { classifyFinalOutputProviderLimit } from './automation-run-provider-limit';

/** Stored run error for a job whose automation_result call failed and that recorded no result. */
export const RESULT_REPORT_FAILED = 'Automation could not report its result';

/**
 * A failed automation_result call in the session history. Claude's outcome is folded into its tool_use record
 * (turn-tool-outcome-projection.ts); Codex records a separate tool_result named after the tool.
 */
function resultReportFailed(instance: Instance | undefined): boolean {
  return instance?.outputBuffer.some((message) => {
    const name = message.metadata?.['name'] ?? message.metadata?.['toolName'];
    return (message.type === 'tool_use' || message.type === 'tool_result') && message.metadata?.['is_error'] === true
      && typeof name === 'string' && /(?:^|__|\.)automation_result$/.test(name);
  }) === true;
}

/** Evaluate the final output only after the caller has established settled completion. */
export function completedAutomationTurnError(tracking: RunTracking, result: AutomationResult | null, instance: Instance | undefined): string | null {
  return classifyFinalOutputProviderLimit(tracking.lastAssistantOutput)
    ?? (!result && resultReportFailed(instance) ? RESULT_REPORT_FAILED : null)
    ?? (!result && !tracking.seenAssistantOutput ? 'No result or assistant text was returned' : null);
}

export function reconcileAutomationInstance(instance: Instance, tracking: RunTracking,
  fail: (reason: string, options?: { retryable?: boolean }) => void, complete: () => void,
  held: (provider: string, resumeAt: number) => void): void {
  const assistant = [...instance.outputBuffer].reverse().find((message) =>
    message.type === 'assistant' && message.content.trim().length > 0
  );
  if (assistant) {
    tracking.seenAssistantOutput = true;
    tracking.lastAssistantOutput = assistant.content;
  }
  // LT-196: miner-only records are not automation output.
  tracking.outputChunks.push(...instance.outputBuffer
    .filter(isVisibleOutputMessage)
    .slice(-20).map((message) => ({
    kind: message.type,
    content: message.content,
    timestamp: message.timestamp,
  })));

  if (FAILURE_STATUSES.has(instance.status)) {
    fail(`Instance entered ${instance.status}`);
    return;
  }

  if (WAIT_STATUSES.has(instance.status)) {
    // See handleInstanceEvent: parking for human approval/input is not a
    // transient failure, so it must not trigger the retry loop.
    fail(
      instance.status === 'waiting_for_permission'
        ? 'Automation requires unattended permission approval'
        : 'Automation requires unattended user input',
      { retryable: false },
    );
    return;
  }

  // Held on a provider usage limit before tracking began (the first prompt can
  // park within a second of spawn): the runner decides whether to end the run.
  if (instance.waitReason?.kind === 'quota-park') {
    held(instance.waitReason.provider, instance.waitReason.resumeAt);
    return;
  }

  if (instance.status === 'idle' && tracking.seenAssistantOutput) {
    complete();
  }
}
