import { describe, expect, it, vi } from 'vitest';
import type { PlanQueueLinearTeam } from '@contracts/schemas/plan-queue';

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { checkTeamFacts, isProviderAllowedForTeam, offerTeamStatuses, type LiveTeamFacts } from './linear-team-checks';
import type { LinearStatus } from './linear-result-schemas';

const status = (id: string, name: string, type: string): LinearStatus => ({ id, name, type });
const COM_STATUSES = [
  status('s-backlog', 'Backlog', 'backlog'),
  status('s-todo', 'Todo', 'unstarted'),
  status('s-progress', 'In Progress', 'started'),
  status('s-review', 'In Review', 'started'),
  status('s-done', 'Done', 'completed'),
  status('s-canceled', 'Canceled', 'canceled'),
];
const ORC_STATUSES = [...COM_STATUSES, status('s-qa', 'Ready for QA/Test', 'started')];

describe('the statuses the panel offers', () => {
  it('offers Ready for QA/Test as landed where the team has it, and In Review otherwise', () => {
    expect(offerTeamStatuses(ORC_STATUSES)).toEqual({
      startedStatus: { id: 's-progress', name: 'In Progress', kind: 'started' },
      handBackStatus: { id: 's-todo', name: 'Todo', kind: 'unstarted' },
      landedStatus: { id: 's-qa', name: 'Ready for QA/Test', kind: 'started' },
      doneStatus: { id: 's-done', name: 'Done', kind: 'completed' },
    });
    expect(offerTeamStatuses(COM_STATUSES).landedStatus).toEqual({ id: 's-review', name: 'In Review', kind: 'started' });
  });

  it('offers nothing for a status the team does not have, and nothing whose kind would break the schema rules', () => {
    const offered = offerTeamStatuses([status('s-1', 'In Progress', 'unstarted'), status('s-2', 'Done', 'started')]);
    expect(offered).toEqual({ startedStatus: null, handBackStatus: null, landedStatus: null, doneStatus: null });
  });

  it('matches the names without regard to capital letters', () => {
    expect(offerTeamStatuses([status('s-1', 'in progress', 'started')]).startedStatus?.id).toBe('s-1');
  });
});

const own = (overrides: Partial<PlanQueueLinearTeam> = {}): PlanQueueLinearTeam => ({
  teamId: 't-orc', teamKey: 'ORC', teamName: 'orchestrat0r', ownership: 'own',
  startedStatus: { id: 's-progress', name: 'In Progress', kind: 'started' },
  handBackStatus: { id: 's-todo', name: 'Todo', kind: 'unstarted' },
  landedStatus: { id: 's-qa', name: 'Ready for QA/Test', kind: 'started' },
  doneStatus: { id: 's-done', name: 'Done', kind: 'completed' },
  providers: ['claude'],
  ...overrides,
});
const client = (overrides: Partial<PlanQueueLinearTeam> = {}): PlanQueueLinearTeam => ({
  ...own({ teamId: 't-com', teamKey: 'COM', teamName: 'Community Tech', ownership: 'client', doneStatus: null }),
  landedStatus: { id: 's-review', name: 'In Review', kind: 'started' },
  ...overrides,
});
const facts = (overrides: Partial<LiveTeamFacts> = {}): LiveTeamFacts => ({
  team: { id: 't-orc', key: 'ORC', name: 'orchestrat0r', visibility: 'restricted' },
  statuses: ORC_STATUSES,
  members: ['me'],
  ...overrides,
});
const line = (check: ReturnType<typeof checkTeamFacts>, id: string) => check.lines.find((entry) => entry.id === id);

describe('the checks on a saved team', () => {
  it('passes a healthy own team, private and with only James as a member', () => {
    const check = checkTeamFacts(own(), facts(), 'me');
    expect(check.ready).toBe(true);
    expect(check.reasons).toEqual([]);
    expect(check.lines.map((entry) => [entry.id, entry.result])).toEqual([
      ['team', 'ok'], ['started', 'ok'], ['handBack', 'ok'], ['landed', 'ok'], ['done', 'ok'], ['private', 'ok'], ['members', 'ok'],
    ]);
  });

  it('reports a team Linear no longer lists, and checks nothing else about it', () => {
    const check = checkTeamFacts(own(), facts({ team: undefined, statuses: [] }), 'me');
    expect(check.ready).toBe(false);
    expect(check.lines).toEqual([{ id: 'team', result: 'problem', text: 'ORC is no longer in Linear.' }]);
  });

  it('accepts a renamed status that keeps its id', () => {
    const renamed = ORC_STATUSES.map((entry) => (entry.id === 's-qa' ? { ...entry, name: 'Ready for QA' } : entry));
    const check = checkTeamFacts(own(), facts({ statuses: renamed }), 'me');
    expect(line(check, 'landed')?.result).toBe('ok');
    expect(check.ready).toBe(true);
  });

  it('reports a status that was deleted, and one whose kind changed', () => {
    const changed = ORC_STATUSES.filter((entry) => entry.id !== 's-todo').map((entry) => (entry.id === 's-qa' ? { ...entry, type: 'completed' } : entry));
    const check = checkTeamFacts(own(), facts({ statuses: changed }), 'me');
    expect(line(check, 'handBack')).toMatchObject({ result: 'problem', text: 'The "handed back" status "Todo" is no longer in this team.' });
    expect(line(check, 'landed')).toMatchObject({ result: 'problem', text: 'The "code landed" status "Ready for QA/Test" has changed to a different kind in Linear.' });
    expect(check.ready).toBe(false);
  });

  it('reports an own team that is no longer private', () => {
    const check = checkTeamFacts(own(), facts({ team: { id: 't-orc', key: 'ORC', name: 'o', visibility: 'public' } }), 'me');
    expect(line(check, 'private')?.result).toBe('problem');
    expect(check.ready).toBe(false);
  });

  it('counts both of Linear\'s not-open words as private', () => {
    for (const visibility of ['private', 'restricted'])
      expect(line(checkTeamFacts(own(), facts({ team: { id: 't-orc', key: 'ORC', name: 'o', visibility } }), 'me'), 'private')?.result).toBe('ok');
  });

  it('reports a second member of an own team, and says how many', () => {
    const check = checkTeamFacts(own(), facts({ members: ['me', 'jim'] }), 'me');
    expect(line(check, 'members')).toMatchObject({ result: 'problem', text: '1 other person is a member of this team, so it is not private to you.' });
    expect(check.ready).toBe(false);
    expect(line(checkTeamFacts(own(), facts({ members: ['me', 'a', 'b'] }), 'me'), 'members')?.text).toContain('2 other people are');
    expect(line(checkTeamFacts(own(), facts({ members: ['jim'] }), 'me'), 'members')?.result).toBe('problem');
  });

  it('does not guess when the connector gives no visibility: not confirmed private, so not ready', () => {
    const check = checkTeamFacts(own(), facts({ team: { id: 't-orc', key: 'ORC', name: 'o' } }), 'me');
    expect(line(check, 'private')?.result).toBe('cannot-be-checked');
    expect(check.ready).toBe(false);
    expect(check.reasons[0]).toContain('not confirmed private');
  });

  it('does not guess when the connector gives a visibility word it does not know', () => {
    const check = checkTeamFacts(own(), facts({ team: { id: 't-orc', key: 'ORC', name: 'o', visibility: 'something-new' } }), 'me');
    expect(line(check, 'private')?.result).toBe('cannot-be-checked');
    expect(check.ready).toBe(false);
  });

  it('says "cannot be checked" for members when the connector lists none, and stays ready', () => {
    const check = checkTeamFacts(own(), facts({ members: null }), 'me');
    expect(line(check, 'members')?.result).toBe('cannot-be-checked');
    expect(check.ready).toBe(true);
  });

  it('asks nothing about privacy or members of a client team, and has no done line', () => {
    const check = checkTeamFacts(client(), facts({ team: { id: 't-com', key: 'COM', name: 'Community Tech', visibility: 'public' }, statuses: COM_STATUSES, members: ['a', 'b'] }), 'me');
    expect(check.lines.map((entry) => entry.id)).toEqual(['team', 'started', 'handBack', 'landed']);
    expect(check.ready).toBe(true);
  });

  it('is not ready with an empty provider list, and ready with one', () => {
    const none = checkTeamFacts(own({ providers: [] }), facts(), 'me');
    expect(none.ready).toBe(false);
    expect(none.reasons).toEqual(['No provider is allowed to see this team\'s ticket text.']);
    expect(checkTeamFacts(own({ providers: ['codex'] }), facts(), 'me').ready).toBe(true);
  });

  it('puts nothing Linear returned on this call into a sentence: only the saved names and fixed words', () => {
    const renamed = ORC_STATUSES.map((entry) => (entry.id === 's-qa' ? { ...entry, name: 'LINEAR-LIVE-NAME', type: 'completed' } : entry));
    const check = checkTeamFacts(own(), facts({ statuses: renamed, team: { id: 't-orc', key: 'ORC', name: 'LINEAR-LIVE-TEAM', visibility: 'public' } }), 'me');
    expect(JSON.stringify(check)).not.toContain('LINEAR-LIVE');
  });
});

describe('whether a provider may see a team\'s ticket text', () => {
  it('allows only the listed providers, and none when the list is empty', () => {
    expect(isProviderAllowedForTeam({ providers: ['claude'] }, 'claude')).toBe(true);
    expect(isProviderAllowedForTeam({ providers: ['claude'] }, 'codex')).toBe(false);
    expect(isProviderAllowedForTeam({ providers: [] }, 'claude')).toBe(false);
  });

  it('compares through the routing\'s aliases, so openai is codex and gemini is antigravity', () => {
    expect(isProviderAllowedForTeam({ providers: ['codex'] }, 'openai')).toBe(true);
    expect(isProviderAllowedForTeam({ providers: ['openai'] }, 'Codex')).toBe(true);
    expect(isProviderAllowedForTeam({ providers: ['antigravity'] }, 'gemini')).toBe(true);
    expect(isProviderAllowedForTeam({ providers: ['gemini'] }, 'antigravity')).toBe(true);
  });
});
