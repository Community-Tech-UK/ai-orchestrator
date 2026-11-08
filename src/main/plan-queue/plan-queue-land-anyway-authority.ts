/**
 * Who may land a parked item without a passing check ("Land anyway").
 *
 * Allowed, and nothing else (Decision 6 of the Plan Queue autonomy plan):
 *   - James on the Plan Queue page (no caller);
 *   - the Set aside agent in its own folder, which the control check authorises (see plan-queue-control-authority.ts);
 *   - the session that started the run, in the turn a person's message began,
 *     when that message is the latest input the session has had, no other turn
 *     has started since, and the person typed it after the item parked.
 * Everything else is refused with a plain reason: queue workers and checkers,
 * the stranded-run rescuer (landing is not a rescue action, see
 * STRANDED_RESCUE_ACTIONS), any other session, and a parent whose latest input
 * is a Harness notice, an automation prompt, another agent's message or a steer.
 *
 * This checks who spoke, not what they said: an agent could still misread a
 * person's message, so the landing note and the queue's event record point at
 * that message and James can see what the landing was based on. The message text
 * itself is never copied into the commit, a Linear comment or the event record.
 */

import type { PersonTurnCheck, PersonTurnRefusal } from '../instance/input-turn-registry';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

export interface LandAnywayPort {
  isQueueInstance(instanceId: string): boolean;
  instanceExists(instanceId: string): boolean;
  /** The latest-input and turn-count check kept by `InputTurnRegistry`. */
  checkPersonTurn(instanceId: string): PersonTurnCheck;
  /** When the item last moved into `parked`, from the queue's event record (not the row's `updated_at`). */
  lastParkedAt(itemId: string): number | null;
}

/** What the queue's event record keeps about who authorised the landing. No message text. */
export type LandAnywayReference =
  | { actor: 'page' }
  | { actor: 'set-aside'; instanceId: string }
  | { actor: 'session'; instanceId: string; messageId: string; typedAt: number };

export interface LandAnywayApproval {
  /** Follows "Landed without a verifier PASS" in the item's note. */
  by: string;
  reference: LandAnywayReference;
}

const PAGE_HINT = 'James can use Land anyway on the Plan Queue page.';

const TURN_REFUSALS: Record<PersonTurnRefusal, string> = {
  'provider-cannot-report':
    `This session's provider can't report when a turn starts, so Harness can't tell that you are answering James's message. ${PAGE_HINT}`,
  'no-input':
    `Harness has no message from James in this session since it started (it doesn't remember across a restart). Ask James to send one now, or ${PAGE_HINT.toLowerCase()}`,
  'latest-input-not-person':
    `The last thing this session received wasn't a message James typed or spoke: it was a Harness notice, an automation, another agent, or a steering message. Ask James to send it as a normal message, or ${PAGE_HINT.toLowerCase()}`,
  'turn-not-started':
    `Harness hasn't seen a turn start from James's latest message. Ask James to send it again, or ${PAGE_HINT.toLowerCase()}`,
  'another-turn-started':
    `Another turn has started since James's message (for example after background work finished), so this reply can't rely on it. Ask James to send a new message, or ${PAGE_HINT.toLowerCase()}`,
};

/** Local time as HH:MM, for the note ("after James's message at 14:02"). */
function clockTime(epochMs: number): string {
  const date = new Date(epochMs);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** @param callerInstanceId set for MCP callers; undefined is the Plan Queue page. Throws a plain refusal. */
export function authorizeLandAnyway(
  run: PlanQueueRun,
  item: PlanQueueItem,
  callerInstanceId: string | undefined,
  port: LandAnywayPort,
): LandAnywayApproval {
  if (callerInstanceId === undefined) return { by: 'from the Plan Queue page', reference: { actor: 'page' } };

  if (port.isQueueInstance(callerInstanceId)) {
    throw new Error(`A queue worker or checker can't land work without a passing check. ${PAGE_HINT}`);
  }
  if (callerInstanceId !== run.parentInstanceId) {
    if (!port.instanceExists(run.parentInstanceId)) {
      throw new Error(`Landing without a passing check isn't a rescue action, so a session taking over a stranded run can't do it. ${PAGE_HINT} Use action "adopt" to take over the run so its items keep going; after that it needs a message from James.`);
    }
    throw new Error(`Only the session that started this Plan Queue run may do that. ${PAGE_HINT}`);
  }

  const turn = port.checkPersonTurn(callerInstanceId);
  if (!turn.ok) throw new Error(TURN_REFUSALS[turn.reason]);
  const parkedAt = port.lastParkedAt(item.id);
  if (parkedAt === null) {
    throw new Error(`The queue has no record of when this item parked, so Harness can't tell whether James's message came after it. ${PAGE_HINT}`);
  }
  if (turn.typedAt <= parkedAt) {
    throw new Error(`James's latest message was sent before this item parked. Ask him to say it again now, or ${PAGE_HINT.toLowerCase()}`);
  }
  return {
    by: `by the session that started the run, after James's message at ${clockTime(turn.typedAt)}`,
    reference: { actor: 'session', instanceId: callerInstanceId, messageId: turn.messageId, typedAt: turn.typedAt },
  };
}
