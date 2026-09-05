/**
 * N1 — tell the operator when a loop run ends.
 *
 * Instance completion already notifies (`windowManager.notifyAgentCompleted`,
 * wired at `instance-event-forwarding.ts:582`), but a LOOP reaching a terminal
 * state notified nothing. Loops are the runs that go unattended for hours, so
 * the surface that most needed this was the one without it.
 *
 * Pure on purpose: the decision of whether and what to notify is testable
 * without Electron, and `terminate()` keeps one call rather than a policy.
 *
 * There is deliberately NO window-focus suppression here, unlike
 * `notifyAgentCompleted`. The loop coordinator has no window handle, and a
 * parameter that is always `false` in production would be worse than none —
 * it would look like a rule that was being applied. Chatter suppression is
 * already owned by `NotificationService`, which has cooldown, dedupe and quiet
 * hours; this decides only whether an END is worth reporting at all.
 */

import type { LoopState } from '../../shared/types/loop.types';
import { isTerminalLoopRuntimeStatus } from './loop-runtime-status';
import { getSettingsManager } from '../core/config/settings-manager';
import { getNotificationService } from '../notifications/notification-service';

export type LoopTerminalUrgency = 'normal' | 'critical';

export interface LoopTerminalNotice {
  kind: 'loop-finished' | 'loop-needs-you';
  title: string;
  body: string;
  urgency: LoopTerminalUrgency;
}

export interface LoopTerminalNoticeInput {
  status: LoopState['status'];
  reason?: string;
  /** The run's goal, used to say WHICH loop finished when several are running. */
  goal?: string;
  iterations: number;
  notifyEnabled: boolean;
}

/**
 * Which terminal outcomes are "clean". Everything else terminal needs a human.
 *
 * Terminality itself is NOT redefined here — it comes from
 * `isTerminalLoopRuntimeStatus`, the coordinator's own definition. A private
 * list would drift: the first version of this file had one, and it silently
 * omitted `failed`, `no-progress` and `cap-reached` — three of the outcomes an
 * unattended operator most needs to hear about.
 */
const FINISHED_CLEAN: ReadonlySet<string> = new Set(['completed']);

/** Terminal, but the operator chose it, so it is reported without escalation. */
const OPERATOR_INITIATED: ReadonlySet<string> = new Set(['cancelled']);

/** Keep a notification body readable; the full reason is in the HUD. */
const MAX_REASON_CHARS = 140;
const MAX_GOAL_CHARS = 80;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function loopTerminalNotice(
  input: LoopTerminalNoticeInput,
): LoopTerminalNotice | null {
  if (!input.notifyEnabled) return null;

  if (!isTerminalLoopRuntimeStatus(input.status)) return null;
  const finished = FINISHED_CLEAN.has(input.status);

  const goal = input.goal ? clip(input.goal, MAX_GOAL_CHARS) : '';
  const where = goal ? `“${goal}”` : 'A loop run';
  const iterationText = `${input.iterations} iteration${input.iterations === 1 ? '' : 's'}`;

  if (finished) {
    return {
      kind: 'loop-finished',
      title: 'Loop finished',
      body: `${where} completed after ${iterationText}.`,
      urgency: 'normal',
    };
  }

  const reason = input.reason ? clip(input.reason, MAX_REASON_CHARS) : '';
  const headline = input.status === 'completed-needs-review'
    ? 'Loop needs your review'
    : OPERATOR_INITIATED.has(input.status)
      ? 'Loop stopped'
      : input.status === 'no-progress' || input.status === 'cap-reached'
        ? 'Loop stopped without finishing'
        : 'Loop ended with an error';

  return {
    kind: 'loop-needs-you',
    title: headline,
    body: reason
      ? `${where} after ${iterationText}: ${reason}`
      : `${where} after ${iterationText}.`,
    // A cancel is usually the operator's own doing, so it is not escalated.
    urgency: OPERATOR_INITIATED.has(input.status) ? 'normal' : 'critical',
  };
}

/**
 * Fire the notification for a terminating run.
 *
 * Best-effort by construction: everything is inside a catch, because a
 * notification failing must never affect whether a run terminates. Lives here
 * rather than on the coordinator so the coordinator keeps one call — it is
 * already at its LOC ceiling, and adding a policy to it pushed it over.
 */
export function notifyLoopTerminal(
  state: LoopState,
  status: LoopState['status'],
  reason?: string,
): void {
  try {
    const notice = loopTerminalNotice({
      status,
      reason,
      goal: state.config?.initialPrompt,
      iterations: state.totalIterations,
      notifyEnabled: getSettingsManager().get('notifyOnLoopTerminal') !== false,
    });
    if (!notice) return;
    getNotificationService().notify({
      kind: notice.kind,
      title: notice.title,
      body: notice.body,
      urgency: notice.urgency,
      fingerprintFields: { loopRunId: state.id, status },
    });
  } catch {
    // Deliberately swallowed: see above.
  }
}
