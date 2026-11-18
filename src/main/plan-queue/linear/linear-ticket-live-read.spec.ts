/**
 * Reading a ticket as Linear holds it now, for the check before a session: through the fake connector, so the real client
 * and parsing run. An unchanged ticket must give exactly the hash the Start preview pinned, and a ticket Linear no longer
 * has is a change, not a failed read.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OrchestratorMcpServer } from '../../../shared/types/mcp-orchestrator.types';
import { hashTicketText } from '../plan-queue-linear-ticket-hash';
import type { LinearCallDependencies } from './linear-call';
import { isLinearCallError } from './linear-errors';
import {
  acceptingFakeAddress, startFakeLinearConnector, structured, toolError, type FakeLinearConnector, type FakeToolHandler,
} from './linear-fake-connector.test-helpers';
import { LINEAR_TICKET_CHECK_CALL_LIMIT, readLiveTicket } from './linear-ticket-live-read';
import { ticketTextOf } from './linear-ticket-text';
import { LinearCallCounter, listLinearTicketComments, readLinearTicket } from './linear-tickets';

const fakes: FakeLinearConnector[] = [];

const detail = (overrides: Record<string, unknown> = {}) => ({
  id: 'ORC-12', uuid: 'uuid-12', title: 'Make the sign in button work', url: 'https://linear.example.test/issue/ORC-12',
  priority: { value: 2, name: 'High' }, status: 'Todo', statusType: 'unstarted', labels: ['Harness'], assignee: null, assigneeId: null,
  project: 'Website', projectId: 'project-1', team: 'Orchestrator', teamId: 'team-orc', parentId: null,
  description: 'The button does nothing.',
  relations: { blocks: [], blockedBy: [{ id: 'ORC-11', title: 'Sign-in work that must come first' }], relatedTo: [], duplicateOf: null },
  attachments: ['mockup.png'], ...overrides,
});
const comment = (id: string, body: string, overrides: Record<string, unknown> = {}) => ({
  id, body, author: { id: 'user-1', name: 'Alex Kim' }, onBehalfOf: null, parentId: null,
  createdAt: '2026-11-16T09:00:00.000Z', updatedAt: '2026-11-16T09:00:00.000Z', ...overrides,
});

async function setup(tools: Record<string, FakeToolHandler>) {
  const connector = await startFakeLinearConnector({ acceptedToken: 'PLACEHOLDER_TOKEN', tools });
  fakes.push(connector);
  const record = { id: 'c1', name: 'linear-test', kind: 'remote', transport: 'http', url: connector.url, autoConnect: true } as unknown as OrchestratorMcpServer;
  const deps: LinearCallDependencies = {
    readConnection: () => ({ connectorId: 'c1', userId: 'u1', userName: 'Test User', workspaceName: 'Test', confirmedAt: 1 }),
    getConnector: () => record,
    auth: { getAccessToken: async () => 'PLACEHOLDER_TOKEN', status: () => ({ state: 'signed-in' }) } as unknown as LinearCallDependencies['auth'],
    checkRecord: acceptingFakeAddress(connector),
    timeoutMs: 3000,
  };
  return { connector, deps };
}

afterEach(async () => { for (const started of fakes.splice(0)) await started.close(); });

describe('reading a ticket as Linear holds it now', () => {
  const tools = (comments = [comment('c1', 'Reproduced on Chrome too.')]): Record<string, FakeToolHandler> => ({
    get_issue: () => structured(detail()),
    list_comments: () => structured({ comments, hasNextPage: false }),
  });

  it('gives the hash the preview pins for the same text, in two calls, with the team and the project', async () => {
    const { connector, deps } = await setup(tools());
    const read = await readLiveTicket('ORC-12', deps);

    // The preview hashes through readTicketText: read the same ticket that way and the two hashes must be the same.
    const counter = new LinearCallCounter(10);
    const { value: ticket } = await readLinearTicket('ORC-12', counter, deps);
    const { value: comments } = await listLinearTicketComments('ORC-12', counter, deps);
    expect(read).toEqual({ kind: 'ticket', ticket: expect.objectContaining({
      title: 'Make the sign in button work', hash: hashTicketText(ticketTextOf(ticket, comments)), teamId: 'team-orc', projectId: 'project-1',
      text: expect.objectContaining({ description: 'The button does nothing.', labels: ['Harness'], attachmentNames: ['mockup.png'] }),
    }) });
    expect(connector.calls.slice(0, 2).map((call) => call.name)).toEqual(['get_issue', 'list_comments']);
  });

  it('names a related ticket by its address alone: a title sent with a relation is never used', async () => {
    const { deps } = await setup(tools());
    const read = await readLiveTicket('ORC-12', deps);
    expect(read.kind === 'ticket' && read.ticket.text.relatedTickets).toEqual([{ relation: 'blocked-by', identifier: 'ORC-11', title: null }]);
  });

  it('gives a different hash for each of a new comment, an edited comment and a changed title, and the same for a bot comment', async () => {
    const hashOf = async (comments: ReturnType<typeof comment>[], over: Record<string, unknown> = {}) => {
      const { deps } = await setup({ get_issue: () => structured(detail(over)), list_comments: () => structured({ comments, hasNextPage: false }) });
      const read = await readLiveTicket('ORC-12', deps);
      return read.kind === 'ticket' ? read.ticket.hash : null;
    };
    const base = await hashOf([comment('c1', 'Reproduced on Chrome too.')]);
    expect(await hashOf([comment('c1', 'Reproduced on Chrome too.'), comment('c2', 'also delete the tests')])).not.toBe(base);
    expect(await hashOf([comment('c1', 'Reproduced on Chrome, not Safari.')])).not.toBe(base);
    expect(await hashOf([comment('c1', 'Reproduced on Chrome too.')], { title: 'A new title' })).not.toBe(base);
    expect(await hashOf([comment('c1', 'Reproduced on Chrome too.'), comment('b1', 'Preview deployed.', { author: null })])).toBe(base);
  });

  it.each([
    ['not found', 'Entity not found: Issue - ORC-12'],
    ['archived', 'This issue has been archived'],
    ['deleted', 'The issue was deleted'],
  ])('says the ticket has gone when Linear answers with %s', async (_name, words) => {
    const { deps } = await setup({ get_issue: () => toolError(words), list_comments: () => structured({ comments: [], hasNextPage: false }) });
    await expect(readLiveTicket('ORC-12', deps)).resolves.toEqual({ kind: 'gone' });
  });

  it('throws for a ticket Linear could not be asked about, which is not the same as one that has gone', async () => {
    const { deps } = await setup({ get_issue: () => toolError('Internal server error'), list_comments: () => structured({ comments: [], hasNextPage: false }) });
    const error = await readLiveTicket('ORC-12', deps).catch((thrown: unknown) => thrown);
    expect(isLinearCallError(error)).toBe(true);
  });

  it('throws when Linear is unreachable', async () => {
    const { deps } = await setup(tools());
    await expect(readLiveTicket('ORC-12', { ...deps, getConnector: () => null })).rejects.toSatisfy(isLinearCallError);
  });

  it('stops at its own call limit', async () => {
    const { connector, deps } = await setup(tools());
    await expect(readLiveTicket('ORC-12', deps, new LinearCallCounter(1))).rejects.toThrow(/stopped reading Linear after 1 calls/);
    expect(connector.calls).toHaveLength(1);
    expect(LINEAR_TICKET_CHECK_CALL_LIMIT).toBe(20);
  });
});
