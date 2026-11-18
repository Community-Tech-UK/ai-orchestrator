/**
 * A `tickets` run written straight into the store, for the specs that drive a ticket through a whole round on fake
 * sessions. No Linear run can be started outside tests until the Start step, so these tests build one the way the Start
 * step will: a run, its items already queued (tickets skip triage), and one ticket-table row per item.
 */
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { hashTicketText } from './plan-queue-linear-ticket-hash';
import type { LiveTicketRead } from './plan-queue-ticket-guard';
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

/** The hash of what James approved for a test ticket. */
export function approvedHashOf(ticket: TestTicket): string {
  return hashTicketText({ title: ticket.title, description: ticket.text.description, comments: ticket.text.comments });
}

/** What Linear holds now for a ticket, changed from the test ticket in the ways a test names. */
export interface LiveChange {
  title?: string;
  description?: string;
  comments?: ApprovedTicketText['comments'];
  teamId?: string;
  projectId?: string | null;
}

function liveRead(ticket: TestTicket, change: LiveChange = {}): LiveTicketRead {
  const title = change.title ?? ticket.title;
  const text = { ...ticket.text, description: change.description ?? ticket.text.description, comments: change.comments ?? ticket.text.comments };
  return { kind: 'ticket', ticket: { title, text, hash: hashTicketText({ title, description: text.description, comments: text.comments }),
    teamId: change.teamId ?? 'team-orc', projectId: change.projectId === undefined ? 'project-1' : change.projectId } };
}

/**
 * Linear as the check before a session sees it: every ticket as approved until a test changes it. Every read is recorded.
 * `hold()` makes reads wait, so a test can have two checks in flight at once.
 */
export class FakeLinearTickets {
  readonly reads: string[] = [];
  private readonly live = new Map<string, LiveTicketRead | Error>();
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;

  constructor(private readonly tickets: readonly TestTicket[]) {
    for (const ticket of tickets) this.live.set(ticket.identifier, liveRead(ticket));
  }

  readonly read = async (identifier: string): Promise<LiveTicketRead> => {
    this.reads.push(identifier);
    if (this.gate) await this.gate;
    const now = this.live.get(identifier);
    if (now instanceof Error) throw now;
    if (!now) throw new Error(`The fake Linear has no ${identifier}.`);
    return now;
  };

  change(identifier: string, change: LiveChange): void { this.live.set(identifier, liveRead(this.ticket(identifier), change)); }
  gone(identifier: string): void { this.live.set(identifier, { kind: 'gone' }); }
  fail(identifier: string, error: Error): void { this.live.set(identifier, error); }
  restore(identifier: string): void { this.live.set(identifier, liveRead(this.ticket(identifier))); }
  /** Reads wait until `open()`. */
  hold(): void { this.gate = new Promise<void>((resolve) => { this.release = resolve; }); }
  open(): void { this.release?.(); this.gate = null; this.release = null; }

  private ticket(identifier: string): TestTicket {
    const ticket = this.tickets.find((candidate) => candidate.identifier === identifier);
    if (!ticket) throw new Error(`No test ticket ${identifier}.`);
    return ticket;
  }
}

/** Writes the run, one queued item per ticket and one ticket-table row per item. Returns the run and its items. */
export function writeTicketsRun(
  tickets: readonly TestTicket[],
  options: { configure?: (config: PlanQueueRun['config']) => PlanQueueRun['config']; repo: string },
): { run: PlanQueueRun; items: PlanQueueItem[]; table: PlanQueueLinearTicketStore } {
  const parent = fake.addParent();
  const baseConfig = {
    ...DEFAULT_PLAN_QUEUE_CONFIG.tickets, baseBranch: 'main',
    // What Start saves: the projects read and each ticked ticket with the hash James saw. The first check is compared with it.
    linear: { projects: [{ projectId: 'project-1', teamId: 'team-orc' }], previewLoadedAt: 1,
      tickets: tickets.map((ticket) => ({ linearId: ticket.linearId, identifier: ticket.identifier, previewHash: approvedHashOf(ticket) })) }, routing: { workers: [{ provider: 'claude' }], verifiers: [] }, startingProviderExclusions: [],
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
      approvedHash: approvedHashOf(ticket), approvedAt: 100,
    });
    return item;
  });
  return { run, items, table };
}
