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
  return `When the work is complete, call the \`${REPORT_READY_TOOL}\` tool once with \`item_id\` "${itemId}": \`summary\` (two or three plain sentences for a human), \`as_built\` (what you built), \`checks_run\` (each command with its exit code), \`deferred_checks\` (each check that needs a rebuilt app, a person or an outside service: \`title\`, \`steps\`, \`expectedResult\`, \`whyDeferred\`; [] when none; write each one in the \`_livetest.md\` beside the plan under the same title, because the checker compares the two) and \`follow_ups\` (problems you found outside this job's scope; [] when none). Include optional \`capability_gaps\` (up to eight investigated missing controls, using the capability-report schema) when an original check remains blocked. Do not report while a command you started is still running: wait for it to finish first. Confirm the tool answered accepted: true, then stop.`;
}

/**
 * Where a job's folders are when it runs on another computer. That computer has no Harness tools, so the report
 * comes back as a file: `reportFile` belongs to the one worker turn that is starting.
 */
export interface RemoteJobPrompt {
  /** "the Windows PC". */
  computerLabel: string;
  /** This Mac's root checkout, so a path under it can be shown at its place under `planningFolder`. */
  repoRoot: string;
  jobFolder: string;
  planningFolder: string;
  reportFile: string;
}

/** The report instruction for a job on another computer: the same fields as `plan_queue_report_ready`, written to a file. */
export function reportFileTask(itemId: string, remote: Pick<RemoteJobPrompt, 'reportFile'>): string {
  const reservation = `If you reproduce defects needing new LT identifiers, request them from the coordinator before numbering evidence. Once per turn, overwrite the same report file with exactly ${JSON.stringify({ item_id: itemId, reserve_defect_ids: 2 })} (replace 2 with the number needed, from 1 to 8), then end your turn. The coordinator reserves identifiers in its authoritative ledger and sends them in your next message. This request is not a completion report. Never run the allocator in this independent clone. Use returned identifiers once each; retain additional unnumbered evidence for follow_ups. After receiving the response, continue work and overwrite the request with the normal report described below.\n\n`;
  return reservation + `When the work is complete, write your report as one JSON file at \`${remote.reportFile}\` (create or overwrite it; it belongs to this turn only) with these fields instead of calling the \`${REPORT_READY_TOOL}\` tool, which is not available on this computer: \`item_id\` "${itemId}", \`summary\` (two or three plain sentences for a human), \`as_built\` (what you built), \`checks_run\` (a list of objects, one per command you ran, each with \`command\` and its numeric \`exitCode\`), \`deferred_checks\` (each check that needs a rebuilt app, a person or an outside service: an object with \`title\`, \`steps\`, \`expectedResult\` and \`whyDeferred\`; [] when none; write each one in the \`_livetest.md\` beside the plan under the same title, because the checker compares the two) and \`follow_ups\` (problems you found outside this job's scope; [] when none). Include optional \`capability_gaps\` (up to eight investigated missing controls, using the capability-report schema) when an original check remains blocked. Do not write the report while a command you started is still running: wait for it to finish first. Check the file is valid JSON, then stop.`;
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
