import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueLinearFolderReading, PlanQueueLinearTeam } from '@contracts/schemas/plan-queue';
import type { OrchestratorMcpServer } from '../../../shared/types/mcp-orchestrator.types';

const logLines = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../logging/logger', () => {
  const record = (...args: unknown[]) => {
    logLines.push(args);
  };
  return { getLogger: () => ({ info: record, warn: record, error: record, debug: record }) };
});

import { hashTicketText } from '../plan-queue-linear-ticket-hash';
import type { LinearCallDependencies } from './linear-call';
import type { DiscoveryRow } from './linear-discovery';
import {
  acceptingFakeAddress,
  startFakeLinearConnector,
  structured,
  type FakeLinearConnector,
  type FakeToolHandler,
} from './linear-fake-connector.test-helpers';
import {
  LINEAR_PREVIEW_LIFETIME_MS,
  LINEAR_PREVIEW_NOT_IN_LIST,
  LINEAR_PREVIEW_OUT_OF_DATE,
  LINEAR_PREVIEW_TOO_MANY,
  LinearPreviewService,
  type LinearPreviewDependencies,
} from './linear-preview';
import { readDiscoveryForFolder, type FolderDiscovery, type LinearTicketReaderDependencies } from './linear-ticket-reader';
import { readTicketText, type TicketTextRead } from './linear-ticket-text';
import type { LinearTicket } from './linear-tickets';

const SECRET_TITLE = 'PLACEHOLDER-TITLE-do-not-log';
const SECRET_BODY = 'PLACEHOLDER-BODY-do-not-log';
const FOLDER = '/work/project';

const status = (id: string, kind: string) => ({ id, name: id, kind });
const ORC_RULES: PlanQueueLinearTeam = {
  teamId: 'team-orc', teamKey: 'ORC', teamName: 'Orchestrator', ownership: 'own',
  startedStatus: status('s-orc-progress', 'started'), handBackStatus: status('s-orc-todo', 'unstarted'),
  landedStatus: status('s-orc-qa', 'started'), doneStatus: status('s-orc-done', 'completed'), providers: ['claude', 'codex'],
};
const COM_RULES: PlanQueueLinearTeam = {
  teamId: 'team-com', teamKey: 'COM', teamName: 'Community', ownership: 'client',
  startedStatus: status('s-com-progress', 'started'), handBackStatus: status('s-com-todo', 'unstarted'),
  landedStatus: status('s-com-review', 'started'), doneStatus: null, providers: [],
};
const ORC_PROJECT = { id: 'project-orc', name: 'Orchestrator', teamId: 'team-orc', teamKey: 'ORC' };
const COM_PROJECT = { id: 'project-com', name: 'Community', teamId: 'team-com', teamKey: 'COM' };
const LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const providerLabel = (id: string) => LABELS[id] ?? id;

const fakes: FakeLinearConnector[] = [];

// ---- A fake connector with the fixture tickets: the real reader, the real text read, the real counter ----

const listed = (identifier: string, overrides: Record<string, unknown> = {}) => {
  const client = identifier.startsWith('COM');
  return {
    id: identifier,
    uuid: `uuid-${identifier}`,
    title: `${SECRET_TITLE} ${identifier}`,
    url: `https://linear.example.test/issue/${identifier}`,
    priority: { value: 3, name: 'Medium' },
    status: 'Todo',
    statusType: 'unstarted',
    labels: ['Harness'],
    assignee: null,
    assigneeId: null,
    project: client ? 'Community' : 'Orchestrator',
    projectId: client ? 'project-com' : 'project-orc',
    team: client ? 'Community' : 'Orchestrator',
    teamId: client ? 'team-com' : 'team-orc',
    parentId: null,
    ...overrides,
  };
};
const noRelations = { blocks: [], blockedBy: [], relatedTo: [], duplicateOf: null };
const comment = (id: string, createdAt: string, overrides: Record<string, unknown> = {}) => ({
  id,
  body: `${SECRET_BODY} comment ${id}`,
  author: { id: 'user-1', name: 'Ada Example' },
  onBehalfOf: null,
  parentId: null,
  createdAt,
  updatedAt: createdAt,
  ...overrides,
});

const SHORT_DESCRIPTION = `${SECRET_BODY} short description`;
const COMMENTS = [
  comment('c1', '2026-11-01T10:00:00.000Z'),
  comment('c2', '2026-11-02T10:00:00.000Z', { author: { id: 'user-2', name: 'Bo Example' } }),
  comment('c3', '2026-11-03T10:00:00.000Z', { author: null }),
];

function ticketTools(count: number, overrides: Record<string, FakeToolHandler> = {}): Record<string, FakeToolHandler> {
  const tickets = Array.from({ length: count }, (_, index) => listed(`ORC-${index + 1}`));
  const descriptions: Record<string, string> = { 'ORC-2': SHORT_DESCRIPTION, 'ORC-3': 'x'.repeat(13_000) };
  return {
    list_issue_labels: () => structured({ labels: [{ id: 'label-1', name: 'Harness' }], hasNextPage: false }),
    list_issues: () => structured({ issues: tickets, hasNextPage: false }),
    get_issue: (args) => structured({
      ...listed(String(args['id'])),
      description: descriptions[String(args['id'])] ?? `${SECRET_BODY} ${String(args['id'])}`,
      relations: noRelations,
      attachments: [],
    }),
    list_comments: (args) => structured({ comments: args['issueId'] === 'ORC-2' ? COMMENTS : [], hasNextPage: false }),
    ...overrides,
  };
}

async function connect(tools: Record<string, FakeToolHandler>, links: 'orc' | 'both' = 'orc') {
  const connector = await startFakeLinearConnector({ acceptedToken: 'PLACEHOLDER_TOKEN', tools });
  fakes.push(connector);
  const record = { id: 'c1', name: 'linear-test', kind: 'remote', transport: 'http', url: connector.url, autoConnect: true } as unknown as OrchestratorMcpServer;
  const call: LinearCallDependencies = {
    readConnection: () => ({ connectorId: 'c1', userId: 'u1', userName: 'Test User', workspaceName: 'Test', confirmedAt: 1 }),
    getConnector: () => record,
    auth: { getAccessToken: async () => 'PLACEHOLDER_TOKEN', status: () => ({ state: 'signed-in' }) } as unknown as LinearCallDependencies['auth'],
    checkRecord: acceptingFakeAddress(connector),
    timeoutMs: 3000,
  };
  const reader: LinearTicketReaderDependencies = {
    readFolder: async (): Promise<PlanQueueLinearFolderReading> => ({
      status: 'linked', folder: FOLDER, privateProject: ORC_PROJECT, clientProjects: links === 'both' ? [COM_PROJECT] : [],
    }),
    isTeamReady: async () => ({ ready: true }),
    readTeams: () => [ORC_RULES, COM_RULES],
    connectionReason: () => null,
    isHeldByUnfinishedRun: () => false,
    landedAt: () => null,
    call,
  };
  const deps: LinearPreviewDependencies = {
    discover: (folder, counter) => readDiscoveryForFolder(folder, counter, reader),
    readText: (identifier, counter) => readTicketText(identifier, counter, call),
    readTeams: () => [ORC_RULES, COM_RULES],
    providerLabel,
    now: () => Date.now(),
  };
  return { connector, deps, service: new LinearPreviewService(deps) };
}

// ---- Stand-ins for the tests that need to control the order things finish in ----

const row = (id: string, identifier: string): DiscoveryRow => ({
  id, identifier, title: `Title of ${identifier}`, priority: 3, assigneeName: null, labels: ['Harness'],
  teamId: 'team-orc', projectId: 'project-orc', ticked: true, canTick: true, waitingFor: [], reason: null, notes: [],
});
const discovery = (): FolderDiscovery => ({
  rows: [row('l1', 'ORC-1'), row('l2', 'ORC-2')],
  labelNote: null,
  projects: [ORC_PROJECT],
  teams: [{ teamId: 'team-orc', teamKey: 'ORC', ownership: 'own', ready: true, reasons: [] }],
});
const ticketRead = (identifier: string, over: Partial<LinearTicket> = {}): TicketTextRead => {
  const ticket: LinearTicket = {
    id: `uuid-${identifier}`, identifier, title: `Title of ${identifier}`, url: '', status: { name: 'Todo', kind: 'unstarted' },
    priority: 3, assignee: null, labels: ['Harness'], project: { id: 'project-orc', name: 'Orchestrator' },
    team: { id: 'team-orc', name: 'Orchestrator' }, parentId: null, description: 'A description.',
    relations: { blocks: [], blockedBy: [], related: [], duplicateOf: [] }, attachmentNames: [], ...over,
  };
  return { ticket, comments: [], hash: `hash-of-${identifier}` };
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function stubDeps(over: Partial<LinearPreviewDependencies> = {}) {
  const discover = vi.fn<LinearPreviewDependencies['discover']>(over.discover ?? (async () => discovery()));
  const readText = vi.fn<LinearPreviewDependencies['readText']>(over.readText ?? (async (identifier) => ticketRead(identifier)));
  const deps: LinearPreviewDependencies = { readTeams: () => [ORC_RULES], providerLabel, now: () => Date.now(), ...over, discover, readText };
  return { deps, discover, readText };
}
const stubService = (over: Partial<LinearPreviewDependencies> = {}) => {
  const stub = stubDeps(over);
  return { ...stub, service: new LinearPreviewService(stub.deps) };
};

beforeEach(() => {
  logLines.length = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  for (const started of fakes.splice(0)) await started.close();
});

describe('loading the list for a folder', () => {
  it('returns the rows of discovery with each linked project, its team\'s readiness and its allowed providers by name', async () => {
    const { service } = await connect(ticketTools(2), 'both');
    const preview = await service.load(FOLDER);
    expect(preview.previewId).toMatch(/\S/);
    expect(preview.folder).toBe(FOLDER);
    expect(preview.expiresAt - preview.loadedAt).toBe(LINEAR_PREVIEW_LIFETIME_MS);
    expect(preview.projects).toEqual([
      {
        projectId: 'project-orc', projectName: 'Orchestrator', teamId: 'team-orc', teamKey: 'ORC', ownership: 'own', ready: true, reasons: [],
        allowedProviders: [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }],
      },
      {
        projectId: 'project-com', projectName: 'Community', teamId: 'team-com', teamKey: 'COM', ownership: 'client', ready: true, reasons: [],
        allowedProviders: [],
      },
    ]);
    // Two ORC tickets and the same two listed under COM's project (dropped: the connector put them in the wrong project).
    expect(preview.rows.map((entry) => [entry.identifier, entry.ticked, entry.canTick])).toEqual([['ORC-1', true, true], ['ORC-2', true, true]]);
    expect(preview.labelNote).toBeNull();
  });

  it('reads the allowed providers from the saved rules each time it loads, and a team with no rules allows none', async () => {
    let saved: readonly PlanQueueLinearTeam[] = [ORC_RULES];
    const { service } = stubService({ readTeams: () => saved });
    expect((await service.load(FOLDER)).projects[0]?.allowedProviders.map((provider) => provider.id)).toEqual(['claude', 'codex']);
    saved = [{ ...ORC_RULES, providers: ['claude'] }];
    expect((await service.load(FOLDER)).projects[0]?.allowedProviders.map((provider) => provider.id)).toEqual(['claude']);
    saved = [];
    expect((await service.load(FOLDER)).projects[0]?.allowedProviders).toEqual([]);
  });

  it('carries a team that is not ready with the reasons, and shows nothing it could not read', async () => {
    const { service } = stubService({
      discover: async () => ({ ...discovery(), teams: [{ teamId: 'team-orc', teamKey: 'ORC', ownership: null, ready: false, reasons: ['ORC has no saved rules.'] }] }),
    });
    const preview = await service.load(FOLDER);
    expect(preview.projects[0]).toMatchObject({ ownership: null, ready: false, reasons: ['ORC has no saved rules.'] });
  });

  it('fails with the reader\'s own words, shows nothing, and keeps the previous preview when a later load fails', async () => {
    const discover = vi.fn<LinearPreviewDependencies['discover']>().mockResolvedValueOnce(discovery()).mockRejectedValueOnce(new Error('Linear could not be reached.'));
    const { service } = stubService({ discover });
    const first = await service.load(FOLDER);
    await expect(service.load(FOLDER)).rejects.toThrow('Linear could not be reached.');
    expect((await service.loadText(first.previewId, 'l1')).identifier).toBe('ORC-1');
  });
});

describe('loading one ticket\'s text', () => {
  it('returns the description, the comments with their authors, the hash and the over-limit flag (one under, one over)', async () => {
    const { service } = await connect(ticketTools(3));
    const preview = await service.load(FOLDER);
    const under = await service.loadText(preview.previewId, 'uuid-ORC-2');
    expect(under).toMatchObject({ linearId: 'uuid-ORC-2', identifier: 'ORC-2', title: `${SECRET_TITLE} ORC-2`, description: SHORT_DESCRIPTION, overLimit: false });
    expect(under.comments.map((entry) => [entry.id, entry.authorName, entry.fromBot])).toEqual([
      ['c1', 'Ada Example', false],
      ['c2', 'Bo Example', false],
      ['c3', null, true],
    ]);
    expect(under.comments[0]?.body).toBe(`${SECRET_BODY} comment c1`);
    // The hash is the queue's own hash of the same text; the comment Linear names no author for is left out of it.
    expect(under.hash).toBe(hashTicketText({
      title: `${SECRET_TITLE} ORC-2`,
      description: SHORT_DESCRIPTION,
      comments: COMMENTS.map((entry) => ({ id: entry.id, authorId: entry.author?.id ?? null, body: entry.body, createdAt: entry.createdAt, fromBot: entry.author === null })),
    }));

    const over = await service.loadText(preview.previewId, 'uuid-ORC-3');
    expect(over.description).toHaveLength(13_000);
    expect(over.overLimit).toBe(true);
  });

  it('keeps the text against the preview, with the title and the text as James saw them', async () => {
    const { service } = await connect(ticketTools(3));
    const preview = await service.load(FOLDER);
    expect(service.heldText(preview.previewId, 'uuid-ORC-2')).toBeNull();
    const text = await service.loadText(preview.previewId, 'uuid-ORC-2');
    const held = service.heldText(preview.previewId, 'uuid-ORC-2');
    expect(held).toMatchObject({ identifier: 'ORC-2', title: `${SECRET_TITLE} ORC-2`, hash: text.hash, overLimit: false });
    expect(held?.text.description).toBe(SHORT_DESCRIPTION);
    expect(held?.text.comments.map((entry) => [entry.id, entry.fromBot])).toEqual([['c1', false], ['c2', false], ['c3', true]]);
  });

  it('names a related ticket only by the title the preview showed, and a parent that is in the list', async () => {
    const { service } = stubService({
      readText: async (identifier) => ticketRead(identifier, {
        parentId: 'l2',
        relations: {
          blocks: [],
          blockedBy: [{ identifier: 'ORC-2', title: 'Title Linear sent' }, { identifier: 'ORC-77', title: 'A ticket outside the list' }],
          related: [],
          duplicateOf: [],
        },
      }),
    });
    const preview = await service.load(FOLDER);
    await service.loadText(preview.previewId, 'l1');
    expect(service.heldText(preview.previewId, 'l1')?.text.relatedTickets).toEqual([
      { relation: 'parent', identifier: 'ORC-2', title: 'Title of ORC-2' },
      { relation: 'blocked-by', identifier: 'ORC-2', title: 'Title of ORC-2' },
      { relation: 'blocked-by', identifier: 'ORC-77', title: null },
    ]);
  });

  it('refuses a ticket the preview did not list, without reading it', async () => {
    const { service, readText } = stubService();
    const preview = await service.load(FOLDER);
    await expect(service.loadText(preview.previewId, 'l-other')).rejects.toThrow(LINEAR_PREVIEW_NOT_IN_LIST);
    expect(readText).not.toHaveBeenCalled();
  });

  it('reads a ticket once: a second request, and one made while the first is reading, share it', async () => {
    const reading = deferred<TicketTextRead>();
    const { service, readText } = stubService({ readText: () => reading.promise });
    const preview = await service.load(FOLDER);
    const first = service.loadText(preview.previewId, 'l1');
    const second = service.loadText(preview.previewId, 'l1');
    reading.resolve(ticketRead('ORC-1'));
    expect(await first).toBe(await second);
    await service.loadText(preview.previewId, 'l1');
    expect(readText).toHaveBeenCalledTimes(1);
  });
});

describe('the call budget', () => {
  it('makes exactly the calls a twenty-ticket list and three texts need, and logs that number and nothing else', async () => {
    const { connector, service } = await connect(ticketTools(20));
    const preview = await service.load(FOLDER);
    // The label, one page of the project's tickets, and one read for each ticket's relations.
    expect(connector.calls).toHaveLength(1 + 1 + 20);
    for (const id of ['uuid-ORC-2', 'uuid-ORC-3', 'uuid-ORC-4']) await service.loadText(preview.previewId, id);
    // Two calls for each text: the ticket, then its comments.
    expect(connector.calls).toHaveLength(22 + 3 * 2);
    expect(connector.calls.filter((entry) => entry.name === 'list_comments').map((entry) => entry.args['issueId'])).toEqual(['ORC-2', 'ORC-3', 'ORC-4']);

    // The preview's own line is the number of calls and nothing else (the connector call logs name only the tool).
    expect(logLines.filter(([message]) => String(message).startsWith('Linear preview'))).toEqual([['Linear preview loaded', { calls: 22 }]]);
    expect(JSON.stringify(logLines)).not.toContain(SECRET_TITLE);
    expect(JSON.stringify(logLines)).not.toContain(SECRET_BODY);
    expect(JSON.stringify(logLines)).not.toContain('Ada Example');
  }, 30_000);

  it('allows the 200th call and fails the load on the 201st, showing nothing and making no further call', async () => {
    // One label call and one page of tickets, then a read for each ticket: 198 tickets make exactly 200 calls.
    const exact = await connect(ticketTools(198));
    expect((await exact.service.load(FOLDER)).rows).toHaveLength(198);
    expect(exact.connector.calls).toHaveLength(200);

    const over = await connect(ticketTools(199));
    await expect(over.service.load(FOLDER)).rejects.toMatchObject({ code: 'call-limit', message: LINEAR_PREVIEW_TOO_MANY });
    expect(over.connector.calls).toHaveLength(200);
    expect(logLines.at(-1)).toEqual(['Linear preview load failed', { calls: 200 }]);
  }, 120_000);

  it('counts the texts against the same 200: the one that would pass it fails, and the list stays usable', async () => {
    const { connector, service } = await connect(ticketTools(198));
    const preview = await service.load(FOLDER);
    await expect(service.loadText(preview.previewId, 'uuid-ORC-2')).rejects.toMatchObject({ code: 'call-limit', message: LINEAR_PREVIEW_TOO_MANY });
    expect(connector.calls).toHaveLength(200);
    expect(service.heldText(preview.previewId, 'uuid-ORC-2')).toBeNull();
  }, 120_000);
});

describe('two at once, and a list that is replaced', () => {
  it('makes one set of calls for two loads of one folder and gives both the same list', async () => {
    const reading = deferred<FolderDiscovery>();
    const { service, discover } = stubService({ discover: () => reading.promise });
    const first = service.load(FOLDER);
    const second = service.load(FOLDER);
    reading.resolve(discovery());
    expect(await first).toBe(await second);
    expect(discover).toHaveBeenCalledTimes(1);
    // The folder written another way is the same folder.
    expect(await service.load(`${FOLDER}/`)).not.toBe(await first);
  });

  it('gives a folder loaded again a new list, and the old list\'s id is out of date', async () => {
    const { service } = stubService();
    const first = await service.load(FOLDER);
    const second = await service.load(FOLDER);
    expect(second.previewId).not.toBe(first.previewId);
    await expect(service.loadText(first.previewId, 'l1')).rejects.toThrow(LINEAR_PREVIEW_OUT_OF_DATE);
    expect((await service.loadText(second.previewId, 'l1')).identifier).toBe('ORC-1');
  });

  it('keeps another folder\'s list when one folder is loaded again', async () => {
    const { service } = stubService();
    const here = await service.load(FOLDER);
    await service.load('/work/other');
    expect((await service.loadText(here.previewId, 'l1')).identifier).toBe('ORC-1');
  });

  it('refuses a text request that started before a newer load, and keeps nothing it read', async () => {
    const reading = deferred<TicketTextRead>();
    const { service, readText } = stubService();
    readText.mockImplementationOnce(() => reading.promise);
    const old = await service.load(FOLDER);
    const request = service.loadText(old.previewId, 'l1');
    const newer = await service.load(FOLDER);
    reading.resolve(ticketRead('ORC-1', { description: 'Text read for the old list.' }));
    await expect(request).rejects.toThrow(LINEAR_PREVIEW_OUT_OF_DATE);
    expect(service.heldText(newer.previewId, 'l1')).toBeNull();
    // The newer list answers for itself, from a fresh read.
    expect((await service.loadText(newer.previewId, 'l1')).description).toBe('A description.');
  });
});

describe('a restart, the 30 minutes and a run that starts', () => {
  it('after a restart no list exists, and a text request says so', async () => {
    const stub = stubDeps();
    const before = new LinearPreviewService(stub.deps);
    const preview = await before.load(FOLDER);
    const afterRestart = new LinearPreviewService(stub.deps);
    await expect(afterRestart.loadText(preview.previewId, 'l1')).rejects.toThrow(LINEAR_PREVIEW_OUT_OF_DATE);
    expect(stub.readText).not.toHaveBeenCalled();
  });

  it('answers until 30 minutes have passed, then says the list is out of date and holds nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { service } = stubService();
    const preview = await service.load(FOLDER);
    await service.loadText(preview.previewId, 'l1');
    vi.advanceTimersByTime(LINEAR_PREVIEW_LIFETIME_MS - 1);
    expect((await service.loadText(preview.previewId, 'l2')).identifier).toBe('ORC-2');
    vi.advanceTimersByTime(1);
    // The list is dropped by its own timer, with no request to notice it.
    expect(vi.getTimerCount()).toBe(0);
    await expect(service.loadText(preview.previewId, 'l1')).rejects.toThrow(LINEAR_PREVIEW_OUT_OF_DATE);
    expect(() => service.heldText(preview.previewId, 'l1')).toThrow(LINEAR_PREVIEW_OUT_OF_DATE);
  });

  it('refuses a request that finds the 30 minutes up, even when the timer has not run yet', async () => {
    let now = 1_000_000;
    const { service } = stubService({ now: () => now });
    const preview = await service.load(FOLDER);
    now += LINEAR_PREVIEW_LIFETIME_MS;
    await expect(service.loadText(preview.previewId, 'l1')).rejects.toThrow(LINEAR_PREVIEW_OUT_OF_DATE);
    service._resetForTesting();
  });

  it('a read that ends after the 30 minutes is refused, not answered', async () => {
    let now = 1_000_000;
    const reading = deferred<TicketTextRead>();
    const { service, readText } = stubService({ now: () => now });
    readText.mockImplementationOnce(() => reading.promise);
    const preview = await service.load(FOLDER);
    const request = service.loadText(preview.previewId, 'l1');
    now += LINEAR_PREVIEW_LIFETIME_MS;
    reading.resolve(ticketRead('ORC-1'));
    await expect(request).rejects.toThrow(LINEAR_PREVIEW_OUT_OF_DATE);
    service._resetForTesting();
  });

  it('drops a list for good when a run starts from it, and a new list does not keep the old timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { service } = stubService();
    const first = await service.load(FOLDER);
    const second = await service.load(FOLDER);
    expect(vi.getTimerCount()).toBe(1);
    service.drop(second.previewId);
    expect(vi.getTimerCount()).toBe(0);
    await expect(service.loadText(second.previewId, 'l1')).rejects.toThrow(LINEAR_PREVIEW_OUT_OF_DATE);
    await expect(service.loadText(first.previewId, 'l1')).rejects.toThrow(LINEAR_PREVIEW_OUT_OF_DATE);
  });
});
