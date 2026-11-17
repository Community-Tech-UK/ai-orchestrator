/**
 * Reads what the Start preview needs from Linear for one project folder, then hands it to the pure `discoverTickets`.
 * Every read goes through `callLinearTool`; nothing is written to Linear.
 *
 * - Only the projects James linked to the folder are asked about, and a ticket that comes back from another project
 *   or team is dropped, so a connector that ignored the filter cannot add tickets of an unlinked project.
 * - A broken link, a paused connection and a failed read are each a `LinearDiscoveryFailure` in fixed words. A failure
 *   is never an empty list.
 * - Descriptions are read only because Linear sends them with the relations (the one read that has blockers). They are
 *   dropped at once: nothing here keeps, logs or returns a description.
 */
import type { PlanQueueLinearFolderReading, PlanQueueLinearProject, PlanQueueLinearTeam } from '@contracts/schemas/plan-queue';
import { callLinearTool, type LinearCallDependencies } from './linear-call';
import {
  HARNESS_LABEL_NAME,
  discoverTickets,
  type DiscoveryBlocker,
  type DiscoveryResult,
  type DiscoveryTeam,
  type DiscoveryTicket,
} from './linear-discovery';
import { isLinearCallError, type LinearFailureCode } from './linear-errors';
import { readAllLinearPages, toLinearPage } from './linear-paging';
import { LinearLabelsPageSchema } from './linear-result-schemas';
import {
  LinearCallCounter,
  isLinearCallLimitError,
  listLinearTickets,
  readLinearTicket,
  type LinearListedTicket,
} from './linear-tickets';
import type { LinearTeamReadiness } from './linear-team-rules';

/** One preview may make at most this many connector calls (Step 5 of the plan owns the number; it matches). */
export const LINEAR_DISCOVERY_CALL_LIMIT = 200;

const PAGE_SIZE = 50;

export type LinearDiscoveryFailureCode =
  | 'not-linked'
  | 'broken-link'
  | 'connection-paused'
  | 'rate-limited'
  | 'call-limit'
  | LinearFailureCode;

/** Why the list could not be built. `message` is fixed words (plus a folder path or the connection's own sentence). */
export class LinearDiscoveryFailure extends Error {
  constructor(readonly code: LinearDiscoveryFailureCode, message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'LinearDiscoveryFailure';
  }
}

export function isLinearDiscoveryFailure(error: unknown): error is LinearDiscoveryFailure {
  return error instanceof LinearDiscoveryFailure;
}

export interface LinearTicketReaderDependencies {
  readFolder(folder: string): Promise<PlanQueueLinearFolderReading>;
  isTeamReady(teamId: string): Promise<LinearTeamReadiness>;
  /** James's saved team rules, read live. */
  readTeams(): readonly PlanQueueLinearTeam[];
  /** Why Linear work may not start now (the connection's own sentence), or null. */
  connectionReason(): string | null;
  /** Whether an unfinished run already holds this ticket. */
  isHeldByUnfinishedRun(linearId: string): boolean;
  /** When Harness last landed this ticket, if it did. */
  landedAt(linearId: string): number | null;
  /** Tests pass the fake connector's call dependencies; the app leaves it out. */
  call?: LinearCallDependencies;
}

/** Reads the folder's tickets and builds the rows. Throws `LinearDiscoveryFailure` and returns nothing on any failure. */
export async function readDiscoveryForFolder(
  folder: string,
  counter: LinearCallCounter,
  deps: LinearTicketReaderDependencies,
): Promise<DiscoveryResult> {
  try {
    return await read(folder, counter, deps);
  } catch (error) {
    throw asDiscoveryFailure(error);
  }
}

async function read(folder: string, counter: LinearCallCounter, deps: LinearTicketReaderDependencies): Promise<DiscoveryResult> {
  const paused = deps.connectionReason();
  if (paused) throw new LinearDiscoveryFailure('connection-paused', paused);

  const reading = await deps.readFolder(folder);
  if (reading.status === 'none')
    throw new LinearDiscoveryFailure('not-linked', 'No Linear project is linked to this folder. Link one on the Plan Queue page.');
  if (reading.status === 'broken')
    throw new LinearDiscoveryFailure('broken-link', `The Linear link for this folder is broken: ${reading.reason}`);
  const projects = reading.privateProject ? [reading.privateProject, ...reading.clientProjects] : [...reading.clientProjects];

  const saved = deps.readTeams();
  const teams = await readTeams(projects, saved, deps);
  const harnessLabel = await readHarnessLabel(counter, deps);

  const listed = new Map<string, DiscoveryTicket>();
  const detailed: LinearListedTicket[] = [];
  for (const project of projects) {
    const rules = saved.find((team) => team.teamId === project.teamId);
    const status = rules ? { statusId: rules.handBackStatus.id } : { statusKind: 'unstarted' as const };
    const { value } = await listLinearTickets({ projectId: project.id, ...status }, counter, deps.call);
    for (const ticket of value) {
      if (ticket.project?.id !== project.id || ticket.team.id !== project.teamId || listed.has(ticket.id)) continue;
      detailed.push(ticket);
      listed.set(ticket.id, {
        id: ticket.id,
        identifier: ticket.identifier,
        title: ticket.title,
        priority: ticket.priority,
        statusKind: ticket.status.kind,
        assigneeName: ticket.assignee?.name ?? null,
        labels: ticket.labels,
        teamId: ticket.team.id,
        projectId: project.id,
        blockedBy: [],
      });
    }
  }

  // The list sends no relations, so each ticket is read once for its blockers. Its description is dropped here.
  const tickets: DiscoveryTicket[] = [];
  for (const ticket of detailed) {
    const { value } = await readLinearTicket(ticket.identifier, counter, deps.call);
    tickets.push({ ...listed.get(ticket.id)!, blockedBy: value.relations.blockedBy.map((blocker) => blocker.identifier) });
  }

  // Each distinct blocker outside the list is looked up once, for its status.
  const inList = new Set(tickets.map((ticket) => ticket.identifier));
  const blockers = new Map<string, DiscoveryBlocker>();
  for (const identifier of new Set(tickets.flatMap((ticket) => ticket.blockedBy))) {
    if (inList.has(identifier)) continue;
    try {
      const { value } = await readLinearTicket(identifier, counter, deps.call);
      blockers.set(identifier, { id: value.id, statusKind: value.status.kind });
    } catch (error) {
      // Linear refused or could not give this one blocker: it stays "not done", so its tickets wait. Anything else
      // (sign-in, reach, the call limit) is the whole list's problem.
      if (!(isLinearCallError(error) && error.code === 'unexpected-result')) throw error;
    }
  }

  const landedBefore = new Map<string, number>();
  for (const id of [...tickets.map((ticket) => ticket.id), ...[...blockers.values()].map((blocker) => blocker.id)]) {
    const landedAt = deps.landedAt(id);
    if (landedAt !== null) landedBefore.set(id, landedAt);
  }
  return discoverTickets({
    tickets,
    harnessLabel,
    teams,
    heldByUnfinishedRun: new Set(tickets.filter((ticket) => deps.isHeldByUnfinishedRun(ticket.id)).map((ticket) => ticket.id)),
    landedBefore,
    blockers,
  });
}

/** Each team of a linked project, with whether it is ready now and why not. */
async function readTeams(
  projects: readonly PlanQueueLinearProject[],
  saved: readonly PlanQueueLinearTeam[],
  deps: LinearTicketReaderDependencies,
): Promise<DiscoveryTeam[]> {
  const teams: DiscoveryTeam[] = [];
  for (const project of projects) {
    if (teams.some((team) => team.teamId === project.teamId)) continue;
    const rules = saved.find((team) => team.teamId === project.teamId);
    const readiness = await deps.isTeamReady(project.teamId);
    teams.push({
      teamId: project.teamId,
      teamKey: rules?.teamKey ?? project.teamKey,
      ownership: rules?.ownership ?? null,
      ready: readiness.ready,
      reasons: readiness.ready ? [] : readiness.reasons,
    });
  }
  return teams;
}

/** Whether the workspace has one label named exactly "Harness". Two such labels, or none, tick nothing. */
async function readHarnessLabel(counter: LinearCallCounter, deps: LinearTicketReaderDependencies): Promise<'one' | 'none' | 'several'> {
  const labels = await readAllLinearPages<{ id: string; name: string }>(async (cursor) => {
    counter.beforeCall();
    const page = await callLinearTool(
      'list_issue_labels',
      { name: HARNESS_LABEL_NAME, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      LinearLabelsPageSchema,
      deps.call,
    );
    return toLinearPage(page.labels, page);
  });
  const exact = labels.filter((label) => label.name === HARNESS_LABEL_NAME).length;
  return exact === 0 ? 'none' : exact === 1 ? 'one' : 'several';
}

function asDiscoveryFailure(error: unknown): unknown {
  if (isLinearDiscoveryFailure(error)) return error;
  if (isLinearCallLimitError(error)) return new LinearDiscoveryFailure('call-limit', 'There are too many tickets to load at once.');
  if (isLinearCallError(error)) {
    // `message` is fixed words written by Harness; Linear's own words stay in `detail`, which is not used here.
    return new LinearDiscoveryFailure(error.rateLimited ? 'rate-limited' : error.code, error.message, error.retryAfterMs);
  }
  return error;
}
