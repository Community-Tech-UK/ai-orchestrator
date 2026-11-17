/**
 * What the Start preview lists, built in code from fixed fields only: team, project, labels, status, priority,
 * assignee, blockers and title. The input type below has no description and no comments, so this function cannot read
 * them, and no model is involved. A ticket's text reaches a prompt only after James has seen it (later steps).
 *
 * Every sentence is fixed words written by Harness plus a team key, a ticket's short address, and the assignee's name
 * (other people's text, shown to James as plain text and never put in a prompt or a run's reason).
 */
import { priorityRank } from '../plan-queue-sort-key';

/** The one workspace label that hands a ticket to Harness. Compared by its exact name. */
export const HARNESS_LABEL_NAME = 'Harness';

/** Linear's word for a finished status kind. */
const COMPLETED_KIND = 'completed';

export interface DiscoveryTicket {
  /** Linear's long id. */
  id: string;
  /** The short address, such as `COM-123`. */
  identifier: string;
  title: string;
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  /** Linear's kind of the ticket's status (`unstarted`, `completed` ...). */
  statusKind: string;
  assigneeName: string | null;
  /** Label names: Linear sends no label ids with a ticket. */
  labels: readonly string[];
  teamId: string;
  projectId: string;
  /** The short addresses of the tickets that block this one. */
  blockedBy: readonly string[];
}

/** One team as discovery needs it. `ownership` is null when James has saved no rules for the team. */
export interface DiscoveryTeam {
  teamId: string;
  teamKey: string;
  ownership: 'own' | 'client' | null;
  ready: boolean;
  /** The fixed sentences that say why the team is not ready; empty when it is. */
  reasons: readonly string[];
}

/** A blocker that is not in the list, as it was looked up. */
export interface DiscoveryBlocker {
  /** Linear's long id, so a landing by Harness can be found. */
  id: string;
  statusKind: string;
}

export interface DiscoveryInput {
  tickets: readonly DiscoveryTicket[];
  /** Whether the workspace has exactly one label called "Harness". With none, or with two, nothing is ticked. */
  harnessLabel: 'one' | 'none' | 'several';
  teams: readonly DiscoveryTeam[];
  /** Linear ids an unfinished run already holds. */
  heldByUnfinishedRun: ReadonlySet<string>;
  /** Linear id to when Harness landed it. Covers the listed tickets and the blockers. */
  landedBefore: ReadonlyMap<string, number>;
  /** Blockers outside the list, by short address. A blocker that is missing here is treated as not done. */
  blockers: ReadonlyMap<string, DiscoveryBlocker>;
}

export interface DiscoveryRow {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  assigneeName: string | null;
  labels: readonly string[];
  teamId: string;
  projectId: string;
  /** Ticked for James: carries the "Harness" label and can be ticked. */
  ticked: boolean;
  canTick: boolean;
  /** The tickets it is waiting for: not done, and not in this list. */
  waitingFor: string[];
  /** Why it cannot be ticked; null when it can. */
  reason: string | null;
  /** What James should know about a ticket that can be ticked. */
  notes: string[];
}

export interface DiscoveryResult {
  rows: DiscoveryRow[];
  /** Set when the "Harness" label cannot be relied on, so nothing is ticked. */
  labelNote: string | null;
}

export const CLIENT_TEAM_REASON = 'Client team. Starting client tickets arrives in a later step.';
export const ALREADY_IN_A_RUN_REASON = 'Already in a run';
export const NO_HARNESS_LABEL_NOTE = `No Linear label is called "${HARNESS_LABEL_NAME}", so no ticket is ticked for you.`;
export const SEVERAL_HARNESS_LABELS_NOTE = `Two or more Linear labels are called "${HARNESS_LABEL_NAME}", so no ticket is ticked for you.`;

function landedNote(landedAt: number): string {
  const day = new Date(landedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  return `Harness landed this on ${day}. Its status in Linear has not been updated.`;
}

function numberOf(identifier: string): number {
  return Number(identifier.slice(identifier.lastIndexOf('-') + 1));
}

/** Urgent, High, Medium, Low, then no priority (`plan-queue-sort-key.ts`); then the identifier's number. */
function compareTickets(a: DiscoveryTicket, b: DiscoveryTicket): number {
  return priorityRank(a.priority) - priorityRank(b.priority)
    || numberOf(a.identifier) - numberOf(b.identifier)
    || a.identifier.localeCompare(b.identifier);
}

export function discoverTickets(input: DiscoveryInput): DiscoveryResult {
  const listed = new Set(input.tickets.map((ticket) => ticket.identifier));
  const teams = new Map(input.teams.map((team) => [team.teamId, team]));

  const blockerIsDone = (identifier: string): boolean => {
    const own = input.tickets.find((ticket) => ticket.identifier === identifier);
    if (own) return own.statusKind === COMPLETED_KIND || input.landedBefore.has(own.id);
    const outside = input.blockers.get(identifier);
    return outside !== undefined && (outside.statusKind === COMPLETED_KIND || input.landedBefore.has(outside.id));
  };

  const rows = [...input.tickets].sort(compareTickets).map((ticket): DiscoveryRow => {
    const team = teams.get(ticket.teamId);
    const waitingFor: string[] = [];
    const startsAfter: string[] = [];
    for (const blocker of [...new Set(ticket.blockedBy)]) {
      if (blocker === ticket.identifier || blockerIsDone(blocker)) continue;
      (listed.has(blocker) ? startsAfter : waitingFor).push(blocker);
    }

    // The first reason that applies is the one shown: a team that is not ready matters most, because nothing about its
    // tickets can be trusted until it is, then a team Harness may not start yet, then a ticket another run holds.
    let reason: string | null = null;
    if (!team || !team.ready) {
      reason = `${team?.teamKey ?? 'This team'} is not ready: ${(team?.reasons ?? []).join(' ')}`.trimEnd();
    } else if (team.ownership !== 'own') {
      reason = CLIENT_TEAM_REASON;
    } else if (input.heldByUnfinishedRun.has(ticket.id)) {
      reason = ALREADY_IN_A_RUN_REASON;
    } else if (waitingFor.length > 0) {
      reason = `Waiting for ${waitingFor.join(', ')}`;
    }

    const canTick = reason === null;
    const notes: string[] = [];
    if (canTick) {
      if (ticket.assigneeName) notes.push(`Assigned to ${ticket.assigneeName}`);
      if (startsAfter.length > 0) notes.push(`Starts after ${startsAfter.join(', ')}`);
      const landedAt = input.landedBefore.get(ticket.id);
      if (landedAt !== undefined) notes.push(landedNote(landedAt));
    }
    return {
      id: ticket.id,
      identifier: ticket.identifier,
      title: ticket.title,
      priority: ticket.priority,
      assigneeName: ticket.assigneeName,
      labels: ticket.labels,
      teamId: ticket.teamId,
      projectId: ticket.projectId,
      ticked: canTick && input.harnessLabel === 'one' && ticket.labels.includes(HARNESS_LABEL_NAME),
      canTick,
      waitingFor,
      reason,
      notes,
    };
  });
  return {
    rows,
    labelNote: input.harnessLabel === 'none' ? NO_HARNESS_LABEL_NOTE : input.harnessLabel === 'several' ? SEVERAL_HARNESS_LABELS_NOTE : null,
  };
}
