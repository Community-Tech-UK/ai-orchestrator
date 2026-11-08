/**
 * Plan Queue prompt text for the worker's completion report (`plan_queue_report_ready`).
 *
 * Kept apart from plan-queue-prompts.ts, which imports from here: the verifier's verdict tool and the
 * worker's report tool are found the same way, so one function builds the discovery steps for both.
 */

export const REPORT_READY_TOOL = 'plan_queue_report_ready';

/** The steps that find a Harness tool from a provider that does not list it natively (shared with the verdict tool). */
export function toolDiscoverySteps(tool: string): readonly string[] {
  return [
    '- If Harness tools are not already callable, use your provider discovery mechanism to find orchestrator.tool_search or orchestrator.tool_describe. Searching only the provider native tool list is insufficient.',
    `- Search Harness for ${tool}, or describe that exact name. Follow the returned input schema and invocation route.`,
    `- If the returned invocation names orchestrator.tool_execute, call it with name ${tool} and an arguments object containing your ${tool === REPORT_READY_TOOL ? 'report' : 'verdict'} fields; discover tool_execute through the provider mechanism if needed.`,
  ];
}

/** Final instruction of every worker turn: report through the tool, then stop. */
export function reportReadyTask(itemId: string): string {
  return `When the work is complete, call the \`${REPORT_READY_TOOL}\` tool once with \`item_id\` "${itemId}": \`summary\` (two or three plain sentences for a human), \`as_built\` (what you built), \`checks_run\` (each command with its exit code), \`deferred_checks\` (each check that needs a rebuilt app, a person or an outside service: \`title\`, \`steps\`, \`expectedResult\`, \`whyDeferred\`; [] when none; write each one in the \`_livetest.md\` beside the plan under the same title, because the checker compares the two) and \`follow_ups\` (problems you found outside this job's scope; [] when none). Do not report while a command you started is still running: wait for it to finish first. Confirm the tool answered accepted: true, then stop.`;
}

/** A follow-up turn for a worker whose turn ended before it reported. */
export function buildWorkerReminderPrompt(itemId: string, reminder: number, maxReminders: number, waitRule: string): string {
  return [
    `Plan Queue reminder ${reminder} of ${maxReminders}: your turn ended without a recorded report for item "${itemId}". Your work is not handed over until \`${REPORT_READY_TOOL}\` returns accepted: true.`,
    '',
    `- ${waitRule} Background commands may have stopped when your turn ended: check their output and run again any check that has no final exit code.`,
    ...toolDiscoverySteps(REPORT_READY_TOOL),
    `- Then report once. ${reportReadyTask(itemId)} If discovery or invocation fails, quote the exact tool error in your reply.`,
  ].join('\n');
}
