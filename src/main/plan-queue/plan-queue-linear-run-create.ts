/**
 * The one function that makes a Linear run (`kind: 'tickets'`), called by one channel, the Plan Queue page's. The page
 * sends the starting session, the preview id and the ids of the ticked tickets. Every title, hash and text comes from the
 * preview this process holds, so a page that lies about them changes nothing: what is written is what James was shown.
 *
 * It refuses, in fixed words and before writing anything, for each of: a preview that is gone or out of date; no ticket or
 * too many; a ticket that was not in the preview, could not be ticked or was never loaded and shown; a client team; a
 * team that is not ready now; an unusable connection; a provider a ticket's team does not allow; a queue session; and a
 * folder the preview was not loaded for. Then it does what `createPlanQueueRun` does for routing, checks and the base branch,
 * through the same helpers.
 *
 * One active run per ticket: after the last await, in one database transaction and with no await inside, it reads which
 * Linear ids an unfinished job already holds, leaves those out, and writes the run, one queued job per remaining ticket and
 * one ticket row each. The preview is dropped once the run is written, so a second start from it is told the list is out
 * of date. Nothing here reads Linear: the claim happens at each ticket's first session (`plan-queue-ticket-guard.ts`).
 *
 * This file imports nothing from the Linear folder. The page's handler hands it the preview, James's saved team rules,
 * the team readiness check and the connection's reason, so no route an agent can call reaches Linear from here. The
 * provider policy (Step 6) and the ticket table come from their own singletons, as they do for every session.
 */
import { normalizeChecklistFolder, PLAN_QUEUE_LINEAR_RUN_MAX_TICKETS } from '@contracts/schemas/plan-queue';
import type { PlanQueueLinearPreview, PlanQueueLinearPreviewRow, PlanQueueLinearTeam, PlanQueueRouting } from '@contracts/schemas/plan-queue';
import { getLogger } from '../logging/logger';
import type { StartRunResult } from './plan-queue-coordinator';
import { getLinearProviderPolicy, type LinearRunTeam } from './plan-queue-linear-providers';
import { getPlanQueueLinearTicketStore } from './plan-queue-linear-ticket-store-singleton';
import { currentProviderExclusions, locateRun, prepareRunConfig, type RunCreateHost } from './plan-queue-run-create';
import { buildSortKey } from './plan-queue-sort-key';
import { newPlanQueueItem } from './plan-queue-state';
import type { ApprovedTicketText } from './plan-queue-ticket-approved-text';
import type { PlanQueueRun } from './plan-queue.types';

const logger = getLogger('PlanQueueLinearRun');

export const LINEAR_START_NO_TICKETS = 'Tick at least one ticket to start a run.';
export const LINEAR_START_TOO_MANY = `A run holds at most ${PLAN_QUEUE_LINEAR_RUN_MAX_TICKETS} tickets. Untick some.`;
export const LINEAR_START_NOT_IN_LIST = 'A ticked ticket is not in this list. Load the list again.';
export const LINEAR_START_OTHER_FOLDER = 'This list was loaded for a different folder. Load it again.';
export const LINEAR_START_TABLE_MISSING = 'The Linear ticket table is not available, so a Linear run cannot start.';
export const linearStartCannotTick = (identifier: string, reason: string | null): string =>
  `${identifier} cannot be started${reason ? `: ${reason}` : '.'}`;
export const linearStartNotShown = (identifier: string): string => `Open ${identifier} and read it before starting. Only text you have seen is sent to a session.`;
export const linearStartClientTeam = (identifier: string): string => `${identifier} is in a client team. Starting client tickets arrives in a later step.`;
export const linearStartTeamNotReady = (teamKey: string, reasons: readonly string[]): string => `${teamKey} is not ready: ${reasons.join(' ')}`.trimEnd();
export const linearStartAlreadyInARun = (identifiers: readonly string[]): string => `Already in a run: ${identifiers.join(', ')}.`;

/** A ticket's text as the preview kept it for James: what the run will be written from. */
export interface LinearStartHeldText {
  linearId: string;
  identifier: string;
  address: string;
  title: string;
  text: ApprovedTicketText;
  hash: string;
}

export interface LinearStartInput {
  parentInstanceId: string;
  workspaceCwd?: string;
  previewId: string;
  linearIds: readonly string[];
}

/** What the page's handler hands over. Each is the real service in the app and a stand-in in a test. */
export interface LinearStartSources {
  preview: {
    /** The list, while it is still the folder's current one; throws a fixed-words refusal when it is not. */
    current(previewId: string): PlanQueueLinearPreview;
    shownText(previewId: string, linearId: string): LinearStartHeldText | null;
    drop(previewId: string): void;
  };
  /** James's saved team rules, read now. */
  readTeams(): readonly PlanQueueLinearTeam[];
  isTeamReady(teamId: string): Promise<{ ready: true } | { ready: false; reasons: string[] }>;
  /** Why Linear work may not start now, or null. */
  connectionReason(): string | null;
}

interface TickedTicket {
  row: PlanQueueLinearPreviewRow;
  order: number;
}

/** The ticked ids in the preview's own order, each once. Refuses a count of none or over the limit before anything is read. */
function tickedInPreviewOrder(preview: PlanQueueLinearPreview, linearIds: readonly string[]): TickedTicket[] {
  const wanted = new Set(linearIds);
  if (wanted.size === 0) throw new Error(LINEAR_START_NO_TICKETS);
  if (wanted.size > PLAN_QUEUE_LINEAR_RUN_MAX_TICKETS) throw new Error(LINEAR_START_TOO_MANY);
  const byId = new Map(preview.rows.map((row, order) => [row.id, { row, order }]));
  for (const id of wanted) if (!byId.has(id)) throw new Error(LINEAR_START_NOT_IN_LIST);
  return [...wanted].map((id) => byId.get(id)!).sort((a, b) => a.order - b.order);
}

/** Every refusal that needs only the preview and the saved rules. Nothing has been written. */
function refuseUnstartable(preview: PlanQueueLinearPreview, ticked: readonly TickedTicket[], sources: LinearStartSources): void {
  const saved = sources.readTeams();
  for (const { row } of ticked) {
    if (!row.canTick) throw new Error(linearStartCannotTick(row.identifier, row.reason));
    // Client teams are checked in the preview and again against the rules James has saved now.
    const rules = saved.find((team) => team.teamId === row.teamId);
    const project = preview.projects.find((candidate) => candidate.projectId === row.projectId);
    if (project?.ownership === 'client' || rules?.ownership === 'client') throw new Error(linearStartClientTeam(row.identifier));
    if (sources.preview.shownText(preview.previewId, row.id) === null) throw new Error(linearStartNotShown(row.identifier));
  }
}

/** The teams of the ticked tickets, once each, by the key the preview shows. */
function teamsOf(preview: PlanQueueLinearPreview, ticked: readonly TickedTicket[]): LinearRunTeam[] {
  const teams = new Map<string, LinearRunTeam>();
  for (const { row } of ticked) {
    const key = preview.projects.find((project) => project.teamId === row.teamId)?.teamKey ?? row.identifier.slice(0, row.identifier.lastIndexOf('-'));
    teams.set(row.teamId, { teamId: row.teamId, teamKey: key });
  }
  return [...teams.values()];
}

export async function createLinearRun(
  input: LinearStartInput,
  sources: LinearStartSources,
  host: RunCreateHost,
): Promise<Omit<StartRunResult, 'run'> & { run: PlanQueueRun }> {
  // Everything that can be refused without a wait is refused first.
  const first = sources.preview.current(input.previewId);
  const firstTicked = tickedInPreviewOrder(first, input.linearIds);
  const connection = sources.connectionReason();
  if (connection) throw new Error(connection);
  const place = await locateRun(input, host);
  if (normalizeChecklistFolder(place.startFolder) !== normalizeChecklistFolder(first.folder)) throw new Error(LINEAR_START_OTHER_FOLDER);
  refuseUnstartable(first, firstTicked, sources);

  // Asked again now, not trusted from the preview: a team's rules or Linear can have changed since it was loaded.
  const teams = teamsOf(first, firstTicked);
  for (const team of teams) {
    const readiness = await sources.isTeamReady(team.teamId);
    if (!readiness.ready) throw new Error(linearStartTeamNotReady(team.teamKey, readiness.reasons));
  }
  const providers = getLinearProviderPolicy();
  const configured = await prepareRunConfig(place, { kind: 'tickets' }, host, {
    startingProviderExclusions: currentProviderExclusions(host),
    checkRouting: (routing: PlanQueueRouting) => providers.assertRoutingAllowed(teams, routing, place.parent),
    excludedProviders: providers.checkerExclusions(teams),
  });

  // No await from here to the end: what is read and what is written cannot be separated by another start.
  const preview = sources.preview.current(input.previewId);
  const ticked = tickedInPreviewOrder(preview, input.linearIds);
  refuseUnstartable(preview, ticked, sources);
  const table = getPlanQueueLinearTicketStore();
  if (!table) throw new Error(LINEAR_START_TABLE_MISSING);
  const held = new Map(ticked.map(({ row }) => [row.id, sources.preview.shownText(preview.previewId, row.id)!]));
  // The tickets an unfinished job already holds are left out, and named in the answer.
  const taken = ticked.filter(({ row }) => table.findUnfinishedItem(row.id) !== undefined);
  const starting = ticked.filter((entry) => !taken.includes(entry));
  if (starting.length === 0) throw new Error(linearStartAlreadyInARun(taken.map(({ row }) => row.identifier)));

  const now = host.now();
  const run: PlanQueueRun = {
    id: host.newId(),
    parentInstanceId: input.parentInstanceId,
    parentHistoryThreadId: place.parent.historyThreadId?.trim() || null,
    kind: 'tickets',
    workspaceCwd: place.repoRoot,
    status: 'running',
    config: {
      ...configured.config,
      keepOnThisMac: true,
      linear: {
        projects: [...new Map(starting.map(({ row }) => [row.projectId, { projectId: row.projectId, teamId: row.teamId }])).values()],
        previewLoadedAt: preview.loadedAt,
        tickets: starting.map(({ row }) => ({ linearId: row.id, identifier: row.identifier, previewHash: held.get(row.id)!.hash })),
      },
    },
    relaxation: null,
    workerProvider: configured.routing.workers[0]?.provider ?? null,
    workerModel: configured.routing.workers[0]?.model ?? null,
    startedAt: now,
    endedAt: null,
  };
  host.store.inTransaction(() => {
    host.store.upsertRun(run);
    starting.forEach(({ row }, slot) => {
      const text = held.get(row.id)!;
      const item = newPlanQueueItem(host.newId(), run.id, `linear:${row.id}`, now + slot, {
        sourceKind: 'linear', state: 'queued', sortKey: buildSortKey({ priority: row.priority, discoveryIndex: slot }),
      });
      host.store.upsertItem(item);
      table.insert({
        itemId: item.id, linearId: row.id, identifier: row.identifier, address: text.address, teamId: row.teamId, projectId: row.projectId,
        approvedTitle: text.title, approvedText: text.text, approvedHash: text.hash, approvedAt: now,
      });
    });
  });
  sources.preview.drop(preview.previewId);
  logger.info('Linear run started', { runId: run.id, tickets: starting.length, alreadyInARun: taken.length });
  return { run, excluded: taken.map(({ row }) => row.identifier), routingSetAside: configured.setAside, accountNotes: configured.accountNotes, checklistSetAside: configured.checklistSetAside };
}
