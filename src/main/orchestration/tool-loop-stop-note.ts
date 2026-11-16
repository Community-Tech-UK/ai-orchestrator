/**
 * The carry-on note a session gets on its next turn after Harness stopped a
 * turn for repeating tool calls (`instance-tool-loop-wiring.ts`).
 *
 * Failure it prevents (16 Nov 2026, an OpenCode MiMo session): the model wrote
 * "now let me view the images with the read tool" and then ran the same shell
 * command instead, about 30 times. Harness stopped the turn, the user sent
 * "continue", and with nothing new in its context the model picked up the same
 * plan and looped again within seconds. The note tells it what it repeated and
 * to take a different step. It says only what the model did, never that the
 * stop succeeded, because it is queued whether or not the interrupt took.
 *
 * The note is one line between a fixed head and tail, so the leading-prefix
 * matcher in `harness-guidance.ts` can strip it from re-imported history using
 * `TOOL_LOOP_STOP_NOTE_HEAD`/`TOOL_LOOP_STOP_NOTE_TAIL`.
 */

import type { ToolLoopDetectionEvent } from './doom-loop-detector';

export const TOOL_LOOP_STOP_NOTE_HEAD = '[System: In your previous turn you ';
export const TOOL_LOOP_STOP_NOTE_TAIL = '. Before your next tool call, say in one sentence what you still need, then get it a different way. '
  + 'If you meant to use a different tool, call that tool now. '
  + 'If you are blocked, tell the user what is blocking you instead of trying again.]';

/** Longest tool name kept, so a strange name cannot swell the note; also bounds the matcher's open part. */
const MAX_TOOL_NAME_CHARS = 60;
/** Upper bound on the open part between head and tail, used by the matcher. */
export const TOOL_LOOP_STOP_NOTE_MAX_REASON_CHARS = MAX_TOOL_NAME_CHARS + 100;

/** One line, no brackets: the note must stay a single line between its fixed head and tail. */
function toolLabel(name: string): string {
  const flat = name.replace(/[\s[\]]+/g, ' ').trim() || 'a';
  return flat.length <= MAX_TOOL_NAME_CHARS ? flat : `${flat.slice(0, MAX_TOOL_NAME_CHARS - 1)}…`;
}

function reason({ detector, toolName, count }: Pick<ToolLoopDetectionEvent, 'detector' | 'toolName' | 'count'>): string {
  switch (detector) {
    case 'repeat-no-progress':
      return `ran the ${toolLabel(toolName)} tool ${count} times in a row and got the same result each time`;
    case 'ping-pong':
      // The detector joins the distinct tool names with "/", and a tool name may itself
      // contain "/" (an ACP call title holding a URL), so the label is never split.
      return `kept switching between the same two tool calls (${toolLabel(toolName)}) and got the same results each time`;
    case 'runaway':
      return `called tools ${count} times without finishing`;
  }
}

export function toolLoopStopNote(detection: Pick<ToolLoopDetectionEvent, 'detector' | 'toolName' | 'count'>): string {
  return `${TOOL_LOOP_STOP_NOTE_HEAD}${reason(detection)}${TOOL_LOOP_STOP_NOTE_TAIL}`;
}
