/**
 * A `tickets` run written straight into the store, for the specs that drive a ticket through a whole round on fake
 * sessions. No Linear run can be started outside tests until the Start step, so these tests build one the way the Start
 * step will: a run, its items already queued (tickets skip triage), and one ticket-table row per item.
 */
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { hashTicketText } from './plan-queue-linear-ticket-hash';
import { PlanQueueLinearTicketStore } from './plan-queue-linear-ticket-store';
import type { ApprovedTicketText } from './plan-queue-ticket-approved-text';
import { newPlanQueueItem } from './plan-queue-state';
import { driver, fake, store } from './plan-queue-coordinator.test-helpers';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

export interface TestTicket {
  /** The Linear id; the item's reference is `linear:<id>`. */
  linearId: string;
  identifier: string;
  title: string;
  text: ApprovedTicketText;
}

export function ticketText(description: string, over: Partial<ApprovedTicketText> = {}): ApprovedTicketText {
  return { description, comments: [], labels: ['Harness'], priority: 2, projectName: 'Website', relatedTickets: [], attachmentNames: [], ...over };
}

export const RUN_ID = 'run-tickets';

/** Writes the run, one queued item per ticket and one ticket-table row per item. Returns the run and its items. */
export function writeTicketsRun(
  tickets: readonly TestTicket[],
  options: { configure?: (config: PlanQueueRun['config']) => PlanQueueRun['config']; repo: string },
): { run: PlanQueueRun; items: PlanQueueItem[]; table: PlanQueueLinearTicketStore } {
  const parent = fake.addParent();
  const baseConfig = {
    ...DEFAULT_PLAN_QUEUE_CONFIG.tickets, baseBranch: 'main', routing: { workers: [{ provider: 'claude' }], verifiers: [] }, startingProviderExclusions: [],
    // Harness's own checks are scripted in these specs; the gates are named so a check runs and passes.
    verifierGates: ['npm run lint'], postMergeGate: [],
    startingSessionRoute: { provider: parent.provider, currentModel: parent.currentModel, accountProfileId: undefined, copilotAccountProfileId: undefined },
  };
  const run: PlanQueueRun = {
    id: RUN_ID, parentInstanceId: parent.id, parentHistoryThreadId: parent.historyThreadId ?? null, kind: 'tickets', workspaceCwd: options.repo,
    status: 'running', config: options.configure ? options.configure(baseConfig) : baseConfig, relaxation: null,
    workerProvider: null, workerModel: null, startedAt: 1, endedAt: null,
  };
  store.upsertRun(run);
  const table = new PlanQueueLinearTicketStore(driver);
  const items = tickets.map((ticket, index) => {
    const item = newPlanQueueItem(`item-${ticket.identifier.toLowerCase()}-0000`, run.id, `linear:${ticket.linearId}`, index + 1, {
      sourceKind: 'linear', state: 'queued', sortKey: String(index).padStart(4, '0'),
    });
    store.upsertItem(item);
    table.insert({
      itemId: item.id, linearId: ticket.linearId, identifier: ticket.identifier, address: `https://linear.app/x/issue/${ticket.identifier}`,
      teamId: 'team-orc', projectId: 'project-1', approvedTitle: ticket.title, approvedText: ticket.text,
      approvedHash: hashTicketText({ title: ticket.title, description: ticket.text.description, comments: ticket.text.comments }), approvedAt: 100,
    });
    return item;
  });
  return { run, items, table };
}
