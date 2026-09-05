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

export type ToolLoopSeverity = 'warning' | 'critical';

export interface ToolLoopNotice {
  title: string;
  body: string;
  urgency: 'normal' | 'critical';
}

export interface ToolLoopNoticeInput {
  severity: ToolLoopSeverity;
  toolName: string;
  /** Human wording of the detection window, e.g. "8 calls in 2 minutes". */
  windowDescription: string;
  instanceName?: string;
  /** Whether auto-interrupt will act on this without the operator. */
  autoInterruptEnabled: boolean;
}

// Chosen so the worst case stays inside MAX_BODY_CHARS with the fixed wording:
// a notification body that overflows is truncated by the OS mid-sentence.
const MAX_TOOL_CHARS = 40;
const MAX_WINDOW_CHARS = 60;
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
 */
export function toolLoopNotice(input: ToolLoopNoticeInput): ToolLoopNotice | null {
  if (input.severity !== 'critical') return null;

  const who = input.instanceName ? `${clip(input.instanceName, MAX_NAME_CHARS)}: ` : '';
  const tool = clip(input.toolName, MAX_TOOL_CHARS);
  const window = clip(input.windowDescription, MAX_WINDOW_CHARS);

  // Say what will happen next, so the notification is actionable rather than
  // merely alarming. The two cases need genuinely different responses.
  const consequence = input.autoInterruptEnabled
    ? 'Auto-interrupt will stop it.'
    : 'It will keep going until you stop it — auto-interrupt is off.';

  return {
    title: 'Agent stuck in a tool loop',
    body: `${who}repeating ${tool} (${window}). ${consequence}`,
    urgency: 'critical',
  };
}
