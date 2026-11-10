/**
 * N2 — which tool-loop detections reach a person, and in what words.
 *
 * `instance:doom-loop` is forwarded to the renderer (toast, the bar above the
 * session's message box, the session-list badge) and raised as a desktop
 * notification. Every one of those is an interruption, so only detections a
 * person should act on get through; the rest stay in the log.
 *
 * Pure so the "which detections are worth interrupting a human for" decision is
 * testable without Electron.
 */

import { describeToolLoop, type ToolLoopDetector } from '../../shared/tool-loop-summary';
import { friendlyToolName } from '../../shared/permissions/friendly-tool-name';
import type { ToolLoopDetectionEvent } from './doom-loop-detector';

export interface ToolLoopNotice {
  title: string;
  body: string;
  urgency: 'critical';
}

export interface ToolLoopNoticeInput {
  detector: ToolLoopDetector;
  toolName: string;
  count: number;
  instanceName?: string;
  /** Whether Harness stops the turn itself (`willAutoInterruptToolLoop`). */
  harnessWillStop: boolean;
}

export type ToolLoopDetectionForUser = Pick<ToolLoopDetectionEvent, 'severity' | 'detector' | 'autoStopFailed'>;

/**
 * Whether a detection is shown to the user at all.
 *
 * - A `warn` is the detector's first guess ("might be repeating"). It offered
 *   nothing to do and fired often enough (three identical calls, such as a
 *   skill loaded three times) that the user learned to ignore the whole class.
 *   Only `critical`, at twice the warning threshold, is shown.
 * - `runaway` counts tool calls in one turn. A long working turn passes 200 and
 *   400 calls routinely, so on its own it says nothing about being stuck. It is
 *   shown only when Harness acted on it: it is stopping the turn, or tried and
 *   failed, so the user learns why the turn ended or that it did not.
 */
export function shouldTellUserAboutToolLoop<T extends ToolLoopDetectionForUser>(
  detection: T,
  harnessWillStop: boolean,
): detection is T & { severity: 'critical' } {
  if (detection.severity !== 'critical') return false;
  return detection.detector !== 'runaway' || harnessWillStop || detection.autoStopFailed === true;
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
 * The desktop notification for a detection `shouldTellUserAboutToolLoop` let
 * through. The words come from the shared `tool-loop-summary`, so this
 * notification and its notification-centre entry read the same as the bar in
 * the session.
 */
export function toolLoopNotice(input: ToolLoopNoticeInput): ToolLoopNotice {
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
