/**
 * Plan Queue schemas for the team-rules channels: what Linear offers for each linked team, the checked save of the
 * whole team list, and the live check of every saved team. Re-exported from `plan-queue.schemas.ts`, so callers import
 * them from `@contracts/schemas/plan-queue`.
 *
 * Every sentence in a check or a refusal is fixed words written by Harness plus a team key or a status name that James
 * saved. Nothing Linear returned on this call is used as a sentence. Names are shown as plain text and never placed in
 * a prompt.
 */
import { z } from 'zod';
import type { PlanQueueLinearStatus, PlanQueueLinearTeam } from './plan-queue-linear.schemas';

/** Save: the whole list as the editor holds it. Rows are checked one by one in the main process. */
export const PlanQueueLinearTeamsSavePayloadSchema = z.object({ teams: z.array(z.unknown()).max(51) }).strict();
export type PlanQueueLinearTeamsSavePayload = z.infer<typeof PlanQueueLinearTeamsSavePayloadSchema>;

/** The four statuses Harness sets, and what the panel offers for each as a starting point. `null` when the team has none. */
export interface PlanQueueLinearOfferedStatuses {
  startedStatus: PlanQueueLinearStatus | null;
  handBackStatus: PlanQueueLinearStatus | null;
  landedStatus: PlanQueueLinearStatus | null;
  doneStatus: PlanQueueLinearStatus | null;
}

/** One team the panel has a row for: its statuses as Linear lists them now, and what is offered. */
export interface PlanQueueLinearTeamChoice {
  teamId: string;
  teamKey: string;
  teamName: string;
  /** False when Linear no longer lists the team. */
  exists: boolean;
  statuses: PlanQueueLinearStatus[];
  offered: PlanQueueLinearOfferedStatuses;
}

export interface PlanQueueLinearProviderChoice {
  id: string;
  label: string;
}

export interface PlanQueueLinearTeamChoices {
  teams: PlanQueueLinearTeamChoice[];
  /** The providers the queue can route to, from the queue's own routing code. */
  providers: PlanQueueLinearProviderChoice[];
  /** The providers in James's saved Plan Queue routing: the starting ticks for one of his own teams. */
  routingProviders: string[];
}

/** Why one row of a save was refused. `index` is null for a reason about the whole list. */
export interface PlanQueueLinearTeamRefusal {
  index: number | null;
  reason: string;
}

/** A save either stores the whole list or nothing, and says why for every refused row. */
export type PlanQueueLinearTeamsSaveResult =
  | { saved: true; teams: PlanQueueLinearTeam[] }
  | { saved: false; refused: PlanQueueLinearTeamRefusal[] };

/** One thing checked about a saved team. `cannot-be-checked` means the connector did not say. */
export type PlanQueueLinearTeamCheckLineId = 'team' | 'started' | 'handBack' | 'landed' | 'done' | 'private' | 'members';
export type PlanQueueLinearTeamCheckResult = 'ok' | 'problem' | 'cannot-be-checked';

export interface PlanQueueLinearTeamCheckLine {
  id: PlanQueueLinearTeamCheckLineId;
  result: PlanQueueLinearTeamCheckResult;
  text: string;
}

export interface PlanQueueLinearTeamCheck {
  teamId: string;
  lines: PlanQueueLinearTeamCheckLine[];
  /** Whether Plan Queue may start Linear work for this team now. */
  ready: boolean;
  /** Fixed words for each reason it is not ready; empty when ready. */
  reasons: string[];
}

export interface PlanQueueLinearTeamsCheck {
  /** Unix milliseconds when the check finished. */
  checkedAt: number;
  teams: PlanQueueLinearTeamCheck[];
}
