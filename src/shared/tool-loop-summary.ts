/**
 * Plain wording for a tool-loop detection (`doom-loop-detector.ts`), shared by
 * every place that tells the user about one: the desktop notification and its
 * notification-centre entry (main), and the bar above the session's message
 * box, the Needs you list, the session list and the toast (renderer).
 *
 * The detector's own `windowDescription` ("6 consecutive identical calls
 * (post-compaction canary)") is written for logs, so the words here are built
 * from the detector kind, tool and count instead. "Loop" is avoided on purpose:
 * it is the name of a separate Harness feature.
 */
import { friendlyToolName } from './permissions/friendly-tool-name';

export type ToolLoopDetector = 'repeat-no-progress' | 'ping-pong' | 'runaway';

export interface ToolLoopSummaryInput {
  detector: ToolLoopDetector;
  toolName: string;
  count: number;
}

/** What is being asked, in the session list beside the session's name (and on a Needs you card with no name to show). */
export const TOOL_LOOP_TITLE = 'May be stuck: stop it or let it continue';

/** What "Let it continue" means, said beside the button rather than only in a tooltip. */
export const TOOL_LOOP_CONTINUE_CONSEQUENCE = "If you let it continue, it keeps working and you won't be asked about this again this turn.";

/** What the session has been doing, in one sentence. */
export function describeToolLoop({ detector, toolName, count }: ToolLoopSummaryInput): string {
  switch (detector) {
    case 'repeat-no-progress':
      return `It has run ${friendlyToolName(toolName)} ${count} times in a row and got the same result each time.`;
    case 'ping-pong': {
      // The detector joins the distinct tool names with "/", so a tool whose own
      // name contains "/" would split wrongly; built-in and tool-server names do
      // not. One name means the same tool called two different ways.
      const tools = toolName.split('/').map(friendlyToolName);
      const between = tools.length === 2 ? `${tools[0]} and ${tools[1]}` : `two ${tools[0]} calls`;
      return `It keeps switching between ${between} and getting the same results each time.`;
    }
    case 'runaway':
      return `It has used tools ${count} times in this turn without finishing.`;
  }
}
