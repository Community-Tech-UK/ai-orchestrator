/**
 * N2 — a tool loop deserves more than a toast.
 *
 * `instance:doom-loop` is forwarded to the renderer and shown as a toast
 * (`app.component.ts`). A toast is fine when someone is watching; it is exactly
 * the wrong surface when they are not, and an agent stuck repeating one tool
 * call is a money-burning failure that mostly happens while nobody is looking.
 *
 * Pure so the "which detections are worth interrupting a human for" decision is
 * testable without Electron.
 */

import { describeToolLoop, type ToolLoopDetector } from '../../shared/tool-loop-summary';
import { friendlyToolName } from '../../shared/permissions/friendly-tool-name';

export type ToolLoopSeverity = 'warning' | 'critical';

export interface ToolLoopNotice {
  title: string;
  body: string;
  urgency: 'normal' | 'critical';
}

export interface ToolLoopNoticeInput {
  severity: ToolLoopSeverity;
  detector: ToolLoopDetector;
  toolName: string;
  count: number;
  instanceName?: string;
  /** Whether Harness stops the turn itself (`willAutoInterruptToolLoop`). */
  harnessWillStop: boolean;
}

// Chosen so the worst case stays inside MAX_BODY_CHARS with the fixed wording:
// a notification body that overflows is truncated by the OS mid-sentence.
const MAX_TOOL_CHARS = 40;
const MAX_NAME_CHARS = 30;
/** Upper bound on the rendered body, asserted by the spec. */
export const MAX_BODY_CHARS = 220;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Only `critical` notifies.
 *
 * A `warning` is the detector saying "this might be a loop"; it already has a
 * toast, and promoting every one of them to a desktop notification would train
 * the operator to dismiss the class — which costs exactly when a real one
 * arrives. `critical` means the detector is confident.
 *
 * The words come from the shared `tool-loop-summary`, so this notification and
 * its notification-centre entry read the same as the bar in the session.
 */
export function toolLoopNotice(input: ToolLoopNoticeInput): ToolLoopNotice | null {
  if (input.severity !== 'critical') return null;

  const who = input.instanceName ? `${clip(input.instanceName, MAX_NAME_CHARS)}: ` : '';
  // Clip each name the detector joined with "/", so a long first name cannot cut off the second,
  // after making tool-server names readable (clipping first would leave "mcp__…" raw).
  const toolName = input.toolName.split('/').map((name) => clip(friendlyToolName(name), MAX_TOOL_CHARS)).join('/');
  const what = describeToolLoop({ detector: input.detector, toolName, count: input.count });

  // Say what will happen next, so the notification is actionable rather than
  // merely alarming. The two cases need genuinely different responses.
  const consequence = input.harnessWillStop
    ? 'Harness is stopping it.'
    : 'It keeps going until you stop it.';

  return {
    title: 'A session may be stuck',
    body: `${who}${what} ${consequence}`,
    urgency: 'critical',
  };
}
