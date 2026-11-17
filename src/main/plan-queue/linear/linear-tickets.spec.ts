import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorMcpServer } from '../../../shared/types/mcp-orchestrator.types';

const logLines = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../logging/logger', () => {
  const record = (...args: unknown[]) => {
    logLines.push(args);
  };
  return { getLogger: () => ({ info: record, warn: record, error: record, debug: record }) };
});

import type { LinearCallDependencies } from './linear-call';
import {
  acceptingFakeAddress,
  startFakeLinearConnector,
  structured,
  toolError,
  type FakeLinearConnector,
  type FakeToolHandler,
} from './linear-fake-connector.test-helpers';
import {
  LINEAR_COMMENT_MAX_CHARS,
  LINEAR_DESCRIPTION_MAX_CHARS,
  LINEAR_PAGE_MAX_ITEMS,
  LINEAR_RELATIONS_MAX_ITEMS,
} from './linear-ticket-schemas';
import {
  LinearCallCounter,
  LinearCallLimitError,
  listLinearTicketComments,
  listLinearTickets,
  readLinearTicket,
} from './linear-tickets';

const fakes: FakeLinearConnector[] = [];

// Text that must never appear in a log line, an error message or a `detail`.
const SECRET_TITLE = 'PLACEHOLDER-TITLE-do-not-log';
const SECRET_BODY = 'PLACEHOLDER-BODY-do-not-log';

const listed = (identifier: string, overrides: Record<string, unknown> = {}) => ({
  id: identifier,
  uuid: `uuid-${identifier}`,
  title: `${SECRET_TITLE} ${identifier}`,
  url: `https://linear.example.test/issue/${identifier}`,
  priority: { value: 2, name: 'High' },
  status: 'Todo',
  statusType: 'unstarted',
  labels: ['Harness'],
  assignee: null,
  assigneeId: null,
  project: 'A project',
  projectId: 'project-1',
  team: 'A team',
  teamId: 'team-1',
  parentId: null,
  ...overrides,
});

const detailed = (identifier: string, overrides: Record<string, unknown> = {}) => ({
  ...listed(identifier),
  description: `${SECRET_BODY} description`,
  relations: { blocks: [], blockedBy: [], relatedTo: [], duplicateOf: null },
  attachments: [],
  ...overrides,
});

const comment = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  body: `${SECRET_BODY} ${id}`,
  author: { id: 'user-1', name: 'A Person' },
  onBehalfOf: null,
  parentId: null,
  createdAt: '2026-11-16T09:00:00.000Z',
  updatedAt: '2026-11-16T09:00:00.000Z',
  ...overrides,
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

const byCursor = (pages: Record<string, Record<string, unknown>>): FakeToolHandler => (args) =>
  structured(pages[(args['cursor'] as string | undefined) ?? 'first']);

beforeEach(() => {
  logLines.length = 0;
});

afterEach(async () => {
  for (const started of fakes.splice(0)) await started.close();
});

describe('listing the tickets of one project in one status', () => {
  const threePages = {
    first: { issues: [listed('COM-1'), listed('COM-2')], hasNextPage: true, cursor: 'second' },
    second: { issues: [listed('COM-3')], hasNextPage: true, cursor: 'third' },
    third: { issues: [listed('COM-4'), listed('COM-5')], hasNextPage: false },
  };

  it('joins three pages in order and sends the project and the status as arguments', async () => {
    const { connector, deps } = await setup({ list_issues: byCursor(threePages) });
    const result = await listLinearTickets({ projectId: 'project-1', statusId: 'status-todo' }, new LinearCallCounter(10), deps);
    expect(result.value.map((ticket) => ticket.identifier)).toEqual(['COM-1', 'COM-2', 'COM-3', 'COM-4', 'COM-5']);
    expect(connector.calls.map((call) => call.name)).toEqual(['list_issues', 'list_issues', 'list_issues']);
    const fields = connector.calls[0].args['fields'] as string[];
    expect(connector.calls.map((call) => ({ ...call.args, fields: undefined }))).toEqual([
      { project: 'project-1', state: 'status-todo', limit: 50, fields: undefined },
      { project: 'project-1', state: 'status-todo', limit: 50, fields: undefined, cursor: 'second' },
      { project: 'project-1', state: 'status-todo', limit: 50, fields: undefined, cursor: 'third' },
    ]);
    expect(fields).toContain('uuid');
    expect(fields).not.toContain('description');
  });

  it('sends Linear\'s own kind word when no saved status is given, and refuses both or neither', async () => {
    const { connector, deps } = await setup({ list_issues: byCursor({ first: { issues: [], hasNextPage: false } }) });
    await listLinearTickets({ projectId: 'project-1', statusKind: 'unstarted' }, new LinearCallCounter(10), deps);
    expect(connector.calls[0].args['state']).toBe('unstarted');
    const counter = new LinearCallCounter(10);
    await expect(listLinearTickets({ projectId: 'project-1' }, counter, deps)).rejects.toThrow(/one status id or kind/);
    await expect(listLinearTickets({ projectId: 'project-1', statusId: 'a', statusKind: 'unstarted' }, counter, deps)).rejects.toThrow(/one status id or kind/);
    expect(connector.calls).toHaveLength(1);
  });

  it('turns a listed ticket into Harness\'s own shape', async () => {
    const { deps } = await setup({
      list_issues: () =>
        structured({
          issues: [
            listed('COM-7', { priority: { value: 1, name: 'Urgent' }, assignee: 'Someone', assigneeId: 'user-9', labels: ['Harness', 'Bug'], parentId: 'parent-1' }),
            listed('COM-8', { project: null, projectId: null }),
          ],
          hasNextPage: false,
        }),
    });
    const { value } = await listLinearTickets({ projectId: 'project-1', statusId: 'status-todo' }, new LinearCallCounter(5), deps);
    expect(value[0]).toEqual({
      id: 'uuid-COM-7',
      identifier: 'COM-7',
      title: `${SECRET_TITLE} COM-7`,
      url: 'https://linear.example.test/issue/COM-7',
      status: { name: 'Todo', kind: 'unstarted' },
      priority: 1,
      assignee: { id: 'user-9', name: 'Someone' },
      labels: ['Harness', 'Bug'],
      project: { id: 'project-1', name: 'A project' },
      team: { id: 'team-1', name: 'A team' },
      parentId: 'parent-1',
    });
    expect(value[1].assignee).toBeNull();
    expect(value[1].project).toBeNull();
  });

  it('refuses a priority outside 0 to 4 and a ticket address that is not an address', async () => {
    const badPriority = await setup({ list_issues: () => structured({ issues: [listed('COM-1', { priority: { value: 5, name: 'x' } })], hasNextPage: false }) });
    await expect(listLinearTickets({ projectId: 'p', statusId: 's' }, new LinearCallCounter(5), badPriority.deps)).rejects.toMatchObject({ code: 'unexpected-result' });
    const badAddress = await setup({ list_issues: () => structured({ issues: [listed('not an address')], hasNextPage: false }) });
    await expect(listLinearTickets({ projectId: 'p', statusId: 's' }, new LinearCallCounter(5), badAddress.deps)).rejects.toMatchObject({ code: 'unexpected-result' });
  });

  it('refuses a page with more tickets than a page can hold, and accepts one that is exactly full', async () => {
    const tickets = (count: number) => Array.from({ length: count }, (_, index) => listed(`COM-${index + 1}`));
    const full = await setup({ list_issues: () => structured({ issues: tickets(LINEAR_PAGE_MAX_ITEMS), hasNextPage: false }) });
    expect((await listLinearTickets({ projectId: 'p', statusId: 's' }, new LinearCallCounter(5), full.deps)).value).toHaveLength(LINEAR_PAGE_MAX_ITEMS);
    const over = await setup({ list_issues: () => structured({ issues: tickets(LINEAR_PAGE_MAX_ITEMS + 1), hasNextPage: false }) });
    await expect(listLinearTickets({ projectId: 'p', statusId: 's' }, new LinearCallCounter(5), over.deps)).rejects.toMatchObject({ code: 'unexpected-result' });
  });

  it('fails as a whole when a page repeats its cursor, and returns no partial list', async () => {
    const { deps } = await setup({ list_issues: () => structured({ issues: [listed('COM-1')], hasNextPage: true, cursor: 'same' }) });
    await expect(listLinearTickets({ projectId: 'p', statusId: 's' }, new LinearCallCounter(50), deps)).rejects.toMatchObject({ code: 'unexpected-result' });
  });

  it('reports exactly two calls for a two-page list', async () => {
    const { deps } = await setup({
      list_issues: byCursor({
        first: { issues: [listed('COM-1')], hasNextPage: true, cursor: 'second' },
        second: { issues: [listed('COM-2')], hasNextPage: false },
      }),
    });
    const counter = new LinearCallCounter(10);
    const result = await listLinearTickets({ projectId: 'p', statusId: 's' }, counter, deps);
    expect(result.calls).toBe(2);
    expect(counter.calls).toBe(2);
  });
});

describe('reading one ticket', () => {
  it('reads each kind of relation, the attachments and the full description', async () => {
    const { connector, deps } = await setup({
      get_issue: () =>
        structured(
          detailed('COM-10', {
            relations: {
              blocks: [{ id: 'COM-11', title: 'Blocked one' }],
              blockedBy: [{ id: 'COM-12', title: 'Blocker' }],
              relatedTo: [{ id: 'COM-13', title: 'Related one' }, { id: 'COM-14', title: 'Related two' }],
              duplicateOf: { id: 'COM-15', title: 'Original' },
            },
            attachments: [{ title: 'Design.pdf', url: 'https://example.test/a' }, 'Notes'],
          }),
        ),
    });
    const { value, calls } = await readLinearTicket('COM-10', new LinearCallCounter(3), deps);
    expect(calls).toBe(1);
    expect(value.identifier).toBe('COM-10');
    expect(value.description).toBe(`${SECRET_BODY} description`);
    expect(value.relations).toEqual({
      blocks: [{ identifier: 'COM-11', title: 'Blocked one' }],
      blockedBy: [{ identifier: 'COM-12', title: 'Blocker' }],
      related: [{ identifier: 'COM-13', title: 'Related one' }, { identifier: 'COM-14', title: 'Related two' }],
      duplicateOf: [{ identifier: 'COM-15', title: 'Original' }],
    });
    expect(value.attachmentNames).toEqual(['Design.pdf', 'Notes']);
    expect(connector.calls[0].args['id']).toBe('COM-10');
    expect(connector.calls[0].args['fields']).toEqual(expect.arrayContaining(['description', 'relations', 'attachments']));
  });

  it('reads a ticket with no relations, no description and nothing else to say', async () => {
    const { deps } = await setup({ get_issue: () => structured(detailed('COM-20', { description: null })) });
    const { value } = await readLinearTicket('COM-20', new LinearCallCounter(3), deps);
    expect(value.description).toBe('');
    expect(value.relations).toEqual({ blocks: [], blockedBy: [], related: [], duplicateOf: [] });
    expect(value.attachmentNames).toEqual([]);
  });

  it('fails, naming the ticket, when the description is over the cap, and never returns a shorter text', async () => {
    const { deps } = await setup({ get_issue: () => structured(detailed('COM-30', { description: 'x'.repeat(LINEAR_DESCRIPTION_MAX_CHARS + 1) })) });
    const failure = await readLinearTicket('COM-30', new LinearCallCounter(3), deps).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'unexpected-result' });
    expect((failure as Error).message).toContain('COM-30');
    expect((failure as Error).message).not.toContain('xxxx');
  });

  it('accepts a description of exactly the cap', async () => {
    const { deps } = await setup({ get_issue: () => structured(detailed('COM-31', { description: 'x'.repeat(LINEAR_DESCRIPTION_MAX_CHARS) })) });
    const { value } = await readLinearTicket('COM-31', new LinearCallCounter(3), deps);
    expect(value.description).toHaveLength(LINEAR_DESCRIPTION_MAX_CHARS);
  });

  it('refuses a ticket that names more related tickets than the cap, in any kind of relation', async () => {
    const related = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `COM-${index + 1}`, title: 'A ticket' }));
    const exact = await setup({
      get_issue: () => structured(detailed('COM-50', { relations: { blocks: related(LINEAR_RELATIONS_MAX_ITEMS), blockedBy: [], relatedTo: [], duplicateOf: null } })),
    });
    expect((await readLinearTicket('COM-50', new LinearCallCounter(3), exact.deps)).value.relations.blocks).toHaveLength(LINEAR_RELATIONS_MAX_ITEMS);
    const tooMany = related(LINEAR_RELATIONS_MAX_ITEMS + 1);
    const kinds: Record<string, unknown>[] = [
      { blocks: tooMany, blockedBy: [], relatedTo: [], duplicateOf: null },
      { blocks: [], blockedBy: tooMany, relatedTo: [], duplicateOf: null },
      { blocks: [], blockedBy: [], relatedTo: tooMany, duplicateOf: null },
      { blocks: [], blockedBy: [], relatedTo: [], duplicateOf: tooMany },
    ];
    for (const relations of kinds) {
      const { deps } = await setup({ get_issue: () => structured(detailed('COM-51', { relations })) });
      await expect(readLinearTicket('COM-51', new LinearCallCounter(3), deps)).rejects.toMatchObject({ code: 'unexpected-result' });
    }
  });

  it('reads only by short address', async () => {
    const { connector, deps } = await setup({ get_issue: () => structured(detailed('COM-1')) });
    await expect(readLinearTicket('4defa253-857f-411a-a532-d0ffb5ba715c', new LinearCallCounter(3), deps)).rejects.toThrow('short address');
    expect(connector.calls).toEqual([]);
  });
});

describe('listing a ticket\'s comments', () => {
  it('reads every page, with and without an author, and says who a comment was written for', async () => {
    const { connector, deps } = await setup({
      list_comments: byCursor({
        first: {
          comments: [comment('c1'), comment('c2', { author: null })],
          hasNextPage: true,
          cursor: 'second',
        },
        second: {
          comments: [comment('c3', { onBehalfOf: { id: 'user-2', name: 'Someone Else' }, parentId: 'c1' }), comment('c4', { author: undefined, onBehalfOf: 'A Name' })],
          hasNextPage: false,
        },
      }),
    });
    const { value, calls } = await listLinearTicketComments('COM-40', new LinearCallCounter(5), deps);
    expect(calls).toBe(2);
    expect(value.map((entry) => entry.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(value[0].author).toEqual({ id: 'user-1', name: 'A Person' });
    expect(value[1].author).toBeNull();
    expect(value[2]).toMatchObject({ onBehalfOf: { id: 'user-2', name: 'Someone Else' }, parentId: 'c1' });
    expect(value[3]).toMatchObject({ author: null, onBehalfOf: { name: 'A Name' } });
    expect(value[0]).toMatchObject({ createdAt: '2026-11-16T09:00:00.000Z', updatedAt: '2026-11-16T09:00:00.000Z', onBehalfOf: null });
    expect(connector.calls.map((call) => call.args)).toEqual([
      { issueId: 'COM-40', orderBy: 'createdAt', limit: 50 },
      { issueId: 'COM-40', orderBy: 'createdAt', limit: 50, cursor: 'second' },
    ]);
  });

  it('fails, naming the ticket, when a comment is over the cap', async () => {
    const { deps } = await setup({
      list_comments: () => structured({ comments: [comment('c1'), comment('c2', { body: 'y'.repeat(LINEAR_COMMENT_MAX_CHARS + 1) })], hasNextPage: false }),
    });
    const failure = await listLinearTicketComments('COM-41', new LinearCallCounter(5), deps).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'unexpected-result' });
    expect((failure as Error).message).toContain('COM-41');
  });

  it('refuses a page with more comments than a page can hold', async () => {
    const comments = (count: number) => Array.from({ length: count }, (_, index) => comment(`c${index + 1}`));
    const full = await setup({ list_comments: () => structured({ comments: comments(LINEAR_PAGE_MAX_ITEMS), hasNextPage: false }) });
    expect((await listLinearTicketComments('COM-43', new LinearCallCounter(5), full.deps)).value).toHaveLength(LINEAR_PAGE_MAX_ITEMS);
    const over = await setup({ list_comments: () => structured({ comments: comments(LINEAR_PAGE_MAX_ITEMS + 1), hasNextPage: false }) });
    await expect(listLinearTicketComments('COM-43', new LinearCallCounter(5), over.deps)).rejects.toMatchObject({ code: 'unexpected-result' });
  });

  it('accepts a comment of exactly the cap and a ticket with no comments', async () => {
    const exact = await setup({ list_comments: () => structured({ comments: [comment('c1', { body: 'y'.repeat(LINEAR_COMMENT_MAX_CHARS) })], hasNextPage: false }) });
    expect((await listLinearTicketComments('COM-42', new LinearCallCounter(5), exact.deps)).value).toHaveLength(1);
    const none = await setup({ list_comments: () => structured({ comments: [], hasNextPage: false }) });
    expect((await listLinearTicketComments('COM-42', new LinearCallCounter(5), none.deps)).value).toEqual([]);
  });
});

describe('the call counter and its limit', () => {
  it('stops before the call that would pass the limit, makes no further call, and returns nothing', async () => {
    const { connector, deps } = await setup({
      list_issues: byCursor({
        first: { issues: [listed('COM-1')], hasNextPage: true, cursor: 'second' },
        second: { issues: [listed('COM-2')], hasNextPage: false },
      }),
    });
    const counter = new LinearCallCounter(1);
    const failure = await listLinearTickets({ projectId: 'p', statusId: 's' }, counter, deps).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LinearCallLimitError);
    expect(failure).toMatchObject({ code: 'call-limit', limit: 1 });
    expect(connector.calls).toHaveLength(1);
    expect(counter.calls).toBe(1);
  });

  it('allows exactly the limit', async () => {
    const { connector, deps } = await setup({
      list_issues: byCursor({
        first: { issues: [listed('COM-1')], hasNextPage: true, cursor: 'second' },
        second: { issues: [listed('COM-2')], hasNextPage: false },
      }),
    });
    await expect(listLinearTickets({ projectId: 'p', statusId: 's' }, new LinearCallCounter(2), deps)).resolves.toMatchObject({ calls: 2 });
    expect(connector.calls).toHaveLength(2);
  });

  it('is shared by the functions that use one counter, and a limit of zero allows no call', async () => {
    const { connector, deps } = await setup({
      get_issue: () => structured(detailed('COM-1')),
      list_comments: () => structured({ comments: [], hasNextPage: false }),
    });
    const counter = new LinearCallCounter(2);
    await readLinearTicket('COM-1', counter, deps);
    await listLinearTicketComments('COM-1', counter, deps);
    expect(counter.calls).toBe(2);
    await expect(readLinearTicket('COM-1', counter, deps)).rejects.toBeInstanceOf(LinearCallLimitError);
    await expect(listLinearTicketComments('COM-1', new LinearCallCounter(0), deps)).rejects.toBeInstanceOf(LinearCallLimitError);
    expect(connector.calls).toHaveLength(2);
  });

  it('refuses a limit that is not a whole number', () => {
    expect(() => new LinearCallCounter(-1)).toThrow(RangeError);
    expect(() => new LinearCallCounter(1.5)).toThrow(RangeError);
  });
});

describe('failures and logging', () => {
  it('carries the wait Linear asked for when it limits requests', async () => {
    const { deps } = await setup({ list_issues: () => toolError('Rate limit exceeded. Retry after 7 seconds.') });
    await expect(listLinearTickets({ projectId: 'p', statusId: 's' }, new LinearCallCounter(5), deps)).rejects.toMatchObject({
      code: 'unreachable',
      rateLimited: true,
      retryAfterMs: 7000,
    });
  });

  it('logs no ticket text, on success or on failure, and puts none in an error message', async () => {
    const { deps } = await setup({
      list_issues: () => structured({ issues: [listed('COM-1')], hasNextPage: false }),
      get_issue: () => structured(detailed('COM-1')),
      list_comments: () => structured({ comments: [comment('c1')], hasNextPage: false }),
    });
    const counter = new LinearCallCounter(10);
    await listLinearTickets({ projectId: 'p', statusId: 's' }, counter, deps);
    await readLinearTicket('COM-1', counter, deps);
    await listLinearTicketComments('COM-1', counter, deps);
    const odd = await setup({ get_issue: () => structured({ ...detailed('COM-2'), priority: 'high', description: SECRET_BODY }) });
    const failure = await readLinearTicket('COM-2', new LinearCallCounter(3), odd.deps).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'unexpected-result' });
    expect(JSON.stringify([(failure as Error).message, (failure as { detail?: string }).detail])).not.toContain('PLACEHOLDER-');
    expect(logLines.length).toBeGreaterThan(0);
    expect(JSON.stringify(logLines)).not.toContain('PLACEHOLDER-');
  });
});
