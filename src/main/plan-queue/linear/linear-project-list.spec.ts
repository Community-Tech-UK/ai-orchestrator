import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorMcpServer } from '../../../shared/types/mcp-orchestrator.types';

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import type { LinearCallDependencies } from './linear-call';
import {
  acceptingFakeAddress,
  startFakeLinearConnector,
  structured,
  toolError,
  type FakeLinearConnector,
  type FakeToolHandler,
} from './linear-fake-connector.test-helpers';
import { listLinearProjectChoices } from './linear-project-list';

const fakes: FakeLinearConnector[] = [];

const team = (key: string) => ({ id: `team-${key}`, key, name: `Team ${key}` });
const proj = (id: string, name: string, ...teams: string[]) => ({ id, name, teams: teams.map(team) });

async function setup(listProjects: FakeToolHandler, connected = true) {
  const connector = await startFakeLinearConnector({ acceptedToken: 'PLACEHOLDER_TOKEN', tools: { list_projects: listProjects } });
  fakes.push(connector);
  const record = { id: 'c1', name: 'linear-test', kind: 'remote', transport: 'http', url: connector.url, autoConnect: true } as unknown as OrchestratorMcpServer;
  const deps: LinearCallDependencies = {
    readConnection: () => (connected ? { connectorId: 'c1', userId: 'u1', userName: 'Test User', workspaceName: 'Test', confirmedAt: 1 } : null),
    getConnector: () => record,
    auth: { getAccessToken: async () => 'PLACEHOLDER_TOKEN', status: () => ({ state: 'signed-in' }) } as unknown as LinearCallDependencies['auth'],
    checkRecord: acceptingFakeAddress(connector),
    timeoutMs: 3000,
  };
  return { connector, deps };
}

afterEach(async () => {
  for (const started of fakes.splice(0)) await started.close();
});

describe('listing Linear teams and projects for the editor', () => {
  it('reads every page, asks for the teams of each project, and groups the projects by team', async () => {
    const pages: Record<string, unknown> = {
      first: { projects: [proj('P-2', 'Zebra', 'COM'), proj('P-1', 'Apple', 'COM')], hasNextPage: true, cursor: 'second' },
      second: { projects: [proj('P-3', 'Private work', 'JAM')], hasNextPage: false },
    };
    const { connector, deps } = await setup((args) => structured(pages[(args['cursor'] as string | undefined) ?? 'first'] as Record<string, unknown>));
    const choices = await listLinearProjectChoices(deps);
    expect(choices.teams).toEqual([
      { teamId: 'team-COM', teamKey: 'COM', teamName: 'Team COM', projects: [{ id: 'P-1', name: 'Apple' }, { id: 'P-2', name: 'Zebra' }] },
      { teamId: 'team-JAM', teamKey: 'JAM', teamName: 'Team JAM', projects: [{ id: 'P-3', name: 'Private work' }] },
    ]);
    expect(connector.calls.map((call) => call.args)).toEqual([
      { fields: ['teams'], limit: 50 },
      { fields: ['teams'], limit: 50, cursor: 'second' },
    ]);
  });

  it('offers a project that belongs to two teams under each, and lists it once per team', async () => {
    const { deps } = await setup(() => structured({ projects: [proj('P-1', 'Shared', 'COM', 'JAM', 'COM')], hasNextPage: false }));
    const choices = await listLinearProjectChoices(deps);
    expect(choices.teams.map((entry) => [entry.teamKey, entry.projects])).toEqual([
      ['COM', [{ id: 'P-1', name: 'Shared' }]],
      ['JAM', [{ id: 'P-1', name: 'Shared' }]],
    ]);
  });

  it('asks for names only: no ticket tool is called', async () => {
    const { connector, deps } = await setup(() => structured({ projects: [], hasNextPage: false }));
    await expect(listLinearProjectChoices(deps)).resolves.toEqual({ teams: [] });
    expect(connector.calls.map((call) => call.name)).toEqual(['list_projects']);
  });

  it('fails as a whole when a later page repeats its cursor, and never returns the partial list', async () => {
    const { deps } = await setup(() => structured({ projects: [proj('P-1', 'One', 'COM')], hasNextPage: true, cursor: 'same' }));
    await expect(listLinearProjectChoices(deps)).rejects.toMatchObject({ code: 'unexpected-result' });
  });

  it('fails with the fixed words when Linear answers with an error or with the wrong shape', async () => {
    const failing = await setup(() => toolError('LINEAR-SAYS-SOMETHING'));
    await expect(listLinearProjectChoices(failing.deps)).rejects.toMatchObject({ code: 'unexpected-result', message: 'Linear reported an error for the request.' });
    const odd = await setup(() => structured({ projects: 'nope', hasNextPage: false }));
    await expect(listLinearProjectChoices(odd.deps)).rejects.toMatchObject({ code: 'unexpected-result' });
  });

  it('says the connection is not set up, and calls nothing, when no connection was confirmed', async () => {
    const { connector, deps } = await setup(() => structured({ projects: [], hasNextPage: false }), false);
    await expect(listLinearProjectChoices(deps)).rejects.toMatchObject({ code: 'not-set-up' });
    expect(connector.calls).toEqual([]);
  });
});
