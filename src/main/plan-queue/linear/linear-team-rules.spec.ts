import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueLinearFolderLink, PlanQueueLinearTeam } from '@contracts/schemas/plan-queue';
import type { OrchestratorMcpServer } from '../../../shared/types/mcp-orchestrator.types';

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import type { LinearCallDependencies } from './linear-call';
import {
  acceptingFakeAddress,
  jsonText,
  startFakeLinearConnector,
  structured,
  toolError,
  type FakeLinearConnector,
  type FakeToolHandler,
} from './linear-fake-connector.test-helpers';
import { LinearTeamRuleService, type LinearTeamRuleDependencies } from './linear-team-rules';

const fakes: FakeLinearConnector[] = [];
afterEach(async () => {
  for (const started of fakes.splice(0)) await started.close();
});

const st = (id: string, name: string, type: string) => ({ id, name, type });
const COM_STATUSES = [st('com-backlog', 'Backlog', 'backlog'), st('com-todo', 'Todo', 'unstarted'), st('com-progress', 'In Progress', 'started'),
  st('com-review', 'In Review', 'started'), st('com-done', 'Done', 'completed')];
const ORC_STATUSES = [st('orc-todo', 'Todo', 'unstarted'), st('orc-progress', 'In Progress', 'started'), st('orc-qa', 'Ready for QA/Test', 'started'),
  st('orc-review', 'In Review', 'started'), st('orc-done', 'Done', 'completed')];

const orcEntry = (overrides: Partial<PlanQueueLinearTeam> = {}): PlanQueueLinearTeam => ({
  teamId: 't-orc', teamKey: 'ORC', teamName: 'orchestrat0r', ownership: 'own',
  startedStatus: { id: 'orc-progress', name: 'In Progress', kind: 'started' },
  handBackStatus: { id: 'orc-todo', name: 'Todo', kind: 'unstarted' },
  landedStatus: { id: 'orc-qa', name: 'Ready for QA/Test', kind: 'started' },
  doneStatus: { id: 'orc-done', name: 'Done', kind: 'completed' },
  providers: ['claude'],
  ...overrides,
});
const comEntry = (overrides: Partial<PlanQueueLinearTeam> = {}): PlanQueueLinearTeam => ({
  teamId: 't-com', teamKey: 'COM', teamName: 'Community Tech', ownership: 'client',
  startedStatus: { id: 'com-progress', name: 'In Progress', kind: 'started' },
  handBackStatus: { id: 'com-todo', name: 'Todo', kind: 'unstarted' },
  landedStatus: { id: 'com-review', name: 'In Review', kind: 'started' },
  doneStatus: null,
  providers: ['claude'],
  ...overrides,
});

interface World {
  teams: Array<Record<string, unknown>>;
  statuses: Record<string, ReturnType<typeof st>[]>;
  members: Record<string, string[]>;
}
const freshWorld = (): World => ({
  teams: [
    { id: 't-com', key: 'COM', name: 'Community Tech', visibility: 'public' },
    { id: 't-orc', key: 'ORC', name: 'orchestrat0r', visibility: 'restricted' },
  ],
  statuses: { 't-com': COM_STATUSES, 't-orc': ORC_STATUSES },
  members: { 't-orc': ['me'], 't-com': ['me', 'other'] },
});

async function setup(options: { world?: World; saved?: PlanQueueLinearTeam[]; links?: PlanQueueLinearFolderLink[]; tools?: Record<string, FakeToolHandler>; timeoutMs?: number; saveFails?: boolean } = {}) {
  const world = options.world ?? freshWorld();
  const tools: Record<string, FakeToolHandler> = {
    list_teams: () => structured({ teams: world.teams, hasNextPage: false }),
    list_issue_statuses: (args) => jsonText(world.statuses[args['team'] as string] ?? []),
    list_users: (args) => structured({ users: (world.members[args['team'] as string] ?? []).map((id) => ({ id, name: id })), hasNextPage: false }),
    ...options.tools,
  };
  const connector = await startFakeLinearConnector({ acceptedToken: 'PLACEHOLDER_TOKEN', tools });
  fakes.push(connector);
  const record = { id: 'c1', name: 'linear-test', kind: 'remote', transport: 'http', url: connector.url, autoConnect: true } as unknown as OrchestratorMcpServer;
  const call: LinearCallDependencies = {
    readConnection: () => ({ connectorId: 'c1', userId: 'me', userName: 'Me', workspaceName: 'Test', confirmedAt: 1 }),
    getConnector: () => record,
    auth: { getAccessToken: async () => 'PLACEHOLDER_TOKEN', status: () => ({ state: 'signed-in' }) } as unknown as LinearCallDependencies['auth'],
    checkRecord: acceptingFakeAddress(connector),
    timeoutMs: options.timeoutMs ?? 3000,
  };
  const store = { saved: options.saved ?? ([] as PlanQueueLinearTeam[]), writes: 0 };
  const deps: LinearTeamRuleDependencies = {
    readTeams: () => store.saved,
    saveTeams: (teams) => {
      if (options.saveFails) throw new Error('the write was interrupted');
      store.saved = teams;
      store.writes += 1;
    },
    readLinks: () => options.links ?? [],
    readConnection: call.readConnection,
    readRoutingProviders: () => ['claude', 'openai', 'claude'],
    call,
    now: () => 1_000,
  };
  return { connector, world, store, service: new LinearTeamRuleService(deps) };
}

const project = (teamId: string, teamKey: string) => ({ id: `p-${teamKey}`, name: `Project ${teamKey}`, teamId, teamKey });
const linkTo = (folder: string, ...teams: Array<[string, string]>): PlanQueueLinearFolderLink => ({
  folder, privateProject: null, clientProjects: teams.map(([id, key]) => project(id, key)),
});

describe('what the panel is offered', () => {
  it('lists a row for each team with a linked project, with its statuses and the offered defaults', async () => {
    const { service } = await setup({ links: [linkTo('/work/a', ['t-com', 'COM'], ['t-orc', 'ORC']), linkTo('/work/b', ['t-com', 'COM'])] });
    const choices = await service.choices();
    expect(choices.teams.map((team) => team.teamKey)).toEqual(['COM', 'ORC']);
    const [com, orc] = choices.teams;
    expect(com.offered.landedStatus?.name).toBe('In Review');
    expect(orc.offered.landedStatus?.name).toBe('Ready for QA/Test');
    expect(orc.offered.doneStatus?.name).toBe('Done');
    expect(orc.statuses).toContainEqual({ id: 'orc-qa', name: 'Ready for QA/Test', kind: 'started' });
  });

  it('takes the providers from the routing code, and the starting ticks from the saved routing under their routing ids', async () => {
    const { service } = await setup();
    const choices = await service.choices();
    expect(choices.providers.map((provider) => provider.id)).toEqual(expect.arrayContaining(['claude', 'codex', 'antigravity']));
    expect(choices.providers.every((provider) => provider.label.length > 0)).toBe(true);
    // The saved routing says openai twice over; it is the codex provider here, listed once.
    expect(choices.routingProviders).toEqual(['claude', 'codex']);
  });

  it('keeps a saved team whose link is gone, and marks one Linear no longer lists', async () => {
    const world = freshWorld();
    world.teams = world.teams.filter((team) => team['id'] !== 't-orc');
    const { service } = await setup({ world, saved: [orcEntry()] });
    const choices = await service.choices();
    expect(choices.teams).toHaveLength(1);
    expect(choices.teams[0]).toMatchObject({ teamKey: 'ORC', exists: false, statuses: [] });
  });

  it('reads nothing from Linear when there is nothing to show', async () => {
    const { service, connector } = await setup();
    await expect(service.choices()).resolves.toMatchObject({ teams: [] });
    expect(connector.calls).toEqual([]);
  });
});

describe('saving the team rules', () => {
  it('saves an own team and a client team, with Linear\'s own spelling of the names', async () => {
    const { service, store, world } = await setup();
    world.statuses['t-orc'] = ORC_STATUSES.map((entry) => (entry.id === 'orc-qa' ? { ...entry, name: 'Ready for QA' } : entry));
    const result = await service.save([orcEntry(), comEntry()]);
    expect(result.saved).toBe(true);
    expect(store.saved.map((team) => team.teamKey)).toEqual(['ORC', 'COM']);
    expect(store.saved[0].landedStatus.name).toBe('Ready for QA');
  });

  it('saves a provider under the routing\'s id, so openai is saved as codex', async () => {
    const { service, store } = await setup();
    await service.save([comEntry({ providers: ['openai', 'claude'] })]);
    expect(store.saved[0].providers).toEqual(['codex', 'claude']);
  });

  it('refuses a provider the queue cannot route to, and one listed twice under two names', async () => {
    const { service, store } = await setup();
    const unknown = await service.save([comEntry({ providers: ['not-a-provider'] })]);
    expect(unknown).toMatchObject({ saved: false, refused: [{ index: 0, reason: '"not-a-provider" is not a provider Plan Queue can use.' }] });
    const twice = await service.save([comEntry({ providers: ['openai', 'codex'] })]);
    expect(twice).toMatchObject({ saved: false, refused: [{ index: 0, reason: 'List each provider once.' }] });
    expect(store.saved).toEqual([]);
  });

  it('refuses a done status on a client team', async () => {
    const { service, store } = await setup();
    const result = await service.save([comEntry({ doneStatus: { id: 'com-done', name: 'Done', kind: 'completed' } })]);
    expect(result).toMatchObject({ saved: false, refused: [{ index: 0, reason: expect.stringContaining('A client team has no done status') }] });
    expect(store.saved).toEqual([]);
  });

  it('refuses a landed status of the completed kind', async () => {
    const { service } = await setup();
    const result = await service.save([orcEntry({ landedStatus: { id: 'orc-done', name: 'Done', kind: 'completed' } })]);
    expect(result).toMatchObject({ saved: false, refused: [{ index: 0, reason: expect.stringContaining('never counts as done') }] });
  });

  it('refuses a status that belongs to another team', async () => {
    const { service, store } = await setup();
    const result = await service.save([orcEntry({ startedStatus: { id: 'com-progress', name: 'In Progress', kind: 'started' } })]);
    expect(result).toMatchObject({ saved: false, refused: [{ index: 0, reason: expect.stringContaining('is not one of ORC\'s statuses') }] });
    expect(store.saved).toEqual([]);
  });

  it('refuses a status that no longer exists, and one whose kind has changed', async () => {
    const { service, world } = await setup();
    world.statuses['t-orc'] = ORC_STATUSES.filter((entry) => entry.id !== 'orc-todo').map((entry) => (entry.id === 'orc-qa' ? { ...entry, type: 'completed' } : entry));
    const result = await service.save([orcEntry()]);
    expect(result.saved).toBe(false);
    const reasons = result.saved ? [] : result.refused.map((refusal) => refusal.reason);
    expect(reasons.some((reason) => reason.includes('"handed back" status "Todo" is not one of ORC\'s statuses'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('"code landed" status "Ready for QA/Test" has changed to a different kind'))).toBe(true);
  });

  it('refuses a team Linear no longer lists', async () => {
    const { service, world } = await setup();
    world.teams = world.teams.filter((team) => team['id'] !== 't-com');
    const result = await service.save([comEntry()]);
    expect(result).toMatchObject({ saved: false, refused: [{ index: 0, reason: 'COM is not a team in Linear, so its rules cannot be saved.' }] });
  });

  it('saves nothing at all when one row is refused, and gives every refused row its own reason', async () => {
    const { service, store } = await setup();
    const result = await service.save([orcEntry(), comEntry({ doneStatus: { id: 'com-done', name: 'Done', kind: 'completed' } }), comEntry({ teamId: 't-x', teamKey: 'X' })]);
    expect(result.saved).toBe(false);
    if (!result.saved) expect(result.refused.map((refusal) => refusal.index).sort()).toEqual([1, 2]);
    expect(store.saved).toEqual([]);
    expect(store.writes).toBe(0);
  });

  it('refuses the same team twice', async () => {
    const { service } = await setup();
    const result = await service.save([comEntry(), comEntry()]);
    expect(result).toMatchObject({ saved: false });
  });

  it('refuses a malformed row with a plain sentence instead of failing the request', async () => {
    const { service } = await setup();
    const result = await service.save([{ teamId: 't-com' }, 'nope']);
    expect(result.saved).toBe(false);
    if (!result.saved) expect(result.refused.map((refusal) => refusal.index)).toEqual(expect.arrayContaining([0, 1]));
  });

  it('keeps the old list when the write is interrupted', async () => {
    const { service, store } = await setup({ saved: [comEntry()], saveFails: true });
    await expect(service.save([orcEntry()])).rejects.toThrow('interrupted');
    expect(store.saved.map((team) => team.teamKey)).toEqual(['COM']);
  });

  it('keeps the old list when Linear does not answer, and the next save still works', async () => {
    let hang = true;
    const { service, store } = await setup({
      saved: [comEntry()],
      timeoutMs: 150,
      tools: { list_teams: () => (hang ? 'hang' : structured({ teams: freshWorld().teams, hasNextPage: false })) },
    });
    await expect(service.save([orcEntry()])).rejects.toMatchObject({ code: 'unreachable' });
    expect(store.saved.map((team) => team.teamKey)).toEqual(['COM']);
    hang = false;
    await expect(service.save([orcEntry()])).resolves.toMatchObject({ saved: true });
    expect(store.saved.map((team) => team.teamKey)).toEqual(['ORC']);
  });

  it('saves nothing and says so in fixed words when Linear answers with an error', async () => {
    const { service, store } = await setup({ tools: { list_teams: () => toolError('LINEAR-SAYS-SOMETHING') } });
    await expect(service.save([orcEntry()])).rejects.toMatchObject({ code: 'unexpected-result', message: 'Linear reported an error for the request.' });
    expect(store.saved).toEqual([]);
  });

  it('keeps the last of two saves in a row, each fully checked', async () => {
    const { service, store } = await setup();
    const first = service.save([orcEntry()]);
    const second = service.save([comEntry()]);
    await Promise.all([first, second]);
    expect(store.saved.map((team) => team.teamKey)).toEqual(['COM']);
    expect(store.writes).toBe(2);
  });
});

describe('checking the saved teams', () => {
  it('passes a healthy own team and a healthy client team', async () => {
    const { service } = await setup({ saved: [orcEntry(), comEntry()] });
    const result = await service.checkTeams();
    expect(result.teams.map((team) => [team.teamId, team.ready])).toEqual([['t-orc', true], ['t-com', true]]);
  });

  it('reports a deleted team', async () => {
    const { service, world } = await setup({ saved: [comEntry()] });
    world.teams = [];
    const [team] = (await service.checkTeams()).teams;
    expect(team.ready).toBe(false);
    expect(team.lines).toEqual([{ id: 'team', result: 'problem', text: 'COM is no longer in Linear.' }]);
  });

  it('treats a renamed status with the same id as fine, and reports a status whose kind changed', async () => {
    const { service, world } = await setup({ saved: [orcEntry()] });
    world.statuses['t-orc'] = ORC_STATUSES.map((entry) => (entry.id === 'orc-qa' ? { ...entry, name: 'Ready for QA' } : entry));
    expect((await service.checkTeams()).teams[0].ready).toBe(true);
    world.statuses['t-orc'] = ORC_STATUSES.map((entry) => (entry.id === 'orc-qa' ? { ...entry, type: 'completed' } : entry));
    const [team] = (await service.checkTeams()).teams;
    expect(team.ready).toBe(false);
    expect(team.lines.find((line) => line.id === 'landed')?.result).toBe('problem');
  });

  it('reports an own team that is no longer private, and one with a second member', async () => {
    const { service, world } = await setup({ saved: [orcEntry()] });
    world.teams = world.teams.map((team) => (team['id'] === 't-orc' ? { ...team, visibility: 'public' } : team));
    expect((await service.checkTeams()).teams[0].lines.find((line) => line.id === 'private')?.result).toBe('problem');
    world.teams = freshWorld().teams;
    world.members['t-orc'] = ['me', 'jim'];
    const [team] = (await service.checkTeams()).teams;
    expect(team.lines.find((line) => line.id === 'members')?.result).toBe('problem');
    expect(team.ready).toBe(false);
  });

  it('asks about the members of an own team only, with the team as the filter', async () => {
    const { service, connector } = await setup({ saved: [orcEntry(), comEntry()] });
    await service.checkTeams();
    expect(connector.calls.filter((call) => call.name === 'list_users').map((call) => call.args['team'])).toEqual(['t-orc']);
  });

  it('says "cannot be checked" for the members when the connector cannot list them, and still checks privacy', async () => {
    const { service } = await setup({ saved: [orcEntry()], tools: { list_users: () => toolError('no such tool') } });
    const [team] = (await service.checkTeams()).teams;
    expect(team.lines.find((line) => line.id === 'members')?.result).toBe('cannot-be-checked');
    expect(team.lines.find((line) => line.id === 'private')?.result).toBe('ok');
    expect(team.ready).toBe(true);
  });

  it('passes a sign-in or reach problem on as the whole check\'s problem, not as a gap in the members line', async () => {
    const { service } = await setup({ saved: [orcEntry()], timeoutMs: 150, tools: { list_users: () => 'hang' } });
    await expect(service.checkTeams()).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('does not report against the old entry when James saves while the check is running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let statusCalls = 0;
    const world = freshWorld();
    const { service, store, connector } = await setup({
      world,
      saved: [comEntry({ providers: [] })],
      tools: {
        list_issue_statuses: async (args) => {
          statusCalls += 1;
          // Only the first read, the check's, waits; the save's reads go straight through.
          if (statusCalls === 1) await gate;
          return jsonText(world.statuses[args['team'] as string] ?? []);
        },
      },
    });
    const checking = service.checkTeams();
    await vi.waitFor(() => expect(statusCalls).toBe(1));
    await expect(service.save([comEntry({ providers: ['claude'] })])).resolves.toMatchObject({ saved: true });
    release();
    const [team] = (await checking).teams;
    expect(store.saved[0].providers).toEqual(['claude']);
    // The old entry had no provider and was not ready; the answer is about the new one.
    expect(team.ready).toBe(true);
    expect(connector.calls.filter((call) => call.name === 'list_issue_statuses').length).toBeGreaterThan(2);
  });

  it('gives up with a plain sentence when the list keeps changing under it', async () => {
    let flip = 0;
    const world = freshWorld();
    const { service, store } = await setup({
      world,
      saved: [comEntry()],
      tools: {
        list_teams: () => {
          flip += 1;
          store.saved = [comEntry({ providers: flip % 2 === 0 ? ['claude'] : [] })];
          return structured({ teams: world.teams, hasNextPage: false });
        },
      },
    });
    await expect(service.checkTeams()).rejects.toThrow('The team rules changed while they were being checked. Check again.');
  });
});

describe('is this team ready for a Linear run', () => {
  it('is not ready with no saved entry, and says so without calling Linear', async () => {
    const { service, connector } = await setup();
    const readiness = await service.isTeamReady('t-orc');
    expect(readiness).toEqual({ ready: false, reasons: ['This team has no saved rules. Set them up on the Plan Queue page first.'] });
    expect(connector.calls).toEqual([]);
  });

  it('is not ready with an empty provider list, and is ready with one provider', async () => {
    const empty = await setup({ saved: [comEntry({ providers: [] })] });
    await expect(empty.service.isTeamReady('t-com')).resolves.toEqual({ ready: false, reasons: ['No provider is allowed to see this team\'s ticket text.'] });
    const one = await setup({ saved: [comEntry({ providers: ['claude'] })] });
    await expect(one.service.isTeamReady('t-com')).resolves.toEqual({ ready: true });
  });

  it('is not ready when a live check finds a problem, and gives the reason', async () => {
    const { service, world } = await setup({ saved: [orcEntry()] });
    world.teams = world.teams.map((team) => (team['id'] === 't-orc' ? { ...team, visibility: 'public' } : team));
    const readiness = await service.isTeamReady('t-orc');
    expect(readiness.ready).toBe(false);
    expect(readiness).toMatchObject({ reasons: [expect.stringContaining('open to the whole workspace')] });
  });

  it('does not count one of James\'s own teams as private when the connector does not say', async () => {
    const world = freshWorld();
    world.teams = world.teams.map((team) => (team['id'] === 't-orc' ? { id: team['id'], key: team['key'], name: team['name'] } : team));
    const { service } = await setup({ world, saved: [orcEntry()] });
    const readiness = await service.isTeamReady('t-orc');
    expect(readiness).toMatchObject({ ready: false, reasons: [expect.stringContaining('not confirmed private')] });
  });

  it('checks only the asked team', async () => {
    const { service, connector } = await setup({ saved: [orcEntry(), comEntry()] });
    await service.isTeamReady('t-com');
    expect(connector.calls.filter((call) => call.name === 'list_issue_statuses').map((call) => call.args['team'])).toEqual(['t-com']);
  });

  it('says in Harness\'s own words that it could not check, when Linear cannot be read', async () => {
    const { service } = await setup({ saved: [comEntry()], tools: { list_teams: () => toolError('LINEAR-SAYS-SOMETHING') } });
    const readiness = await service.isTeamReady('t-com');
    expect(readiness).toEqual({ ready: false, reasons: ['Linear reported an error for the request.'] });
  });
});
