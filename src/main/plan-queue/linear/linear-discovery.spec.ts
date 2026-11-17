import { describe, expect, it } from 'vitest';
import {
  ALREADY_IN_A_RUN_REASON,
  CLIENT_TEAM_REASON,
  NO_HARNESS_LABEL_NOTE,
  SEVERAL_HARNESS_LABELS_NOTE,
  discoverTickets,
  type DiscoveryInput,
  type DiscoveryTeam,
  type DiscoveryTicket,
} from './linear-discovery';

const OWN: DiscoveryTeam = { teamId: 'team-orc', teamKey: 'ORC', ownership: 'own', ready: true, reasons: [] };
const CLIENT: DiscoveryTeam = { teamId: 'team-com', teamKey: 'COM', ownership: 'client', ready: true, reasons: [] };

const ticket = (identifier: string, overrides: Partial<DiscoveryTicket> = {}): DiscoveryTicket => ({
  id: `uuid-${identifier}`,
  identifier,
  title: `Title of ${identifier}`,
  priority: 3,
  statusKind: 'unstarted',
  assigneeName: null,
  labels: ['Harness'],
  teamId: 'team-orc',
  projectId: 'project-orc',
  blockedBy: [],
  ...overrides,
});

const input = (tickets: DiscoveryTicket[], overrides: Partial<DiscoveryInput> = {}): DiscoveryInput => ({
  tickets,
  harnessLabel: 'one',
  teams: [OWN, CLIENT],
  heldByUnfinishedRun: new Set(),
  landedBefore: new Map(),
  blockers: new Map(),
  ...overrides,
});

const only = (tickets: DiscoveryTicket[], overrides: Partial<DiscoveryInput> = {}) => discoverTickets(input(tickets, overrides)).rows[0];

describe('discovery order', () => {
  it('lists Urgent, High, Medium, Low, then no priority, and by the identifier number within a priority', () => {
    const result = discoverTickets(input([
      ticket('ORC-2', { priority: 0 }),
      ticket('ORC-30', { priority: 4 }),
      ticket('ORC-9', { priority: 3 }),
      ticket('ORC-10', { priority: 3 }),
      ticket('ORC-8', { priority: 1 }),
      ticket('ORC-1', { priority: 2 }),
    ]));
    // 9 before 10: the number is compared as a number, not as text.
    expect(result.rows.map((row) => row.identifier)).toEqual(['ORC-8', 'ORC-1', 'ORC-9', 'ORC-10', 'ORC-30', 'ORC-2']);
  });
});

describe('what is ticked', () => {
  it('ticks only a ticket that carries the "Harness" label and can be ticked', () => {
    const rows = discoverTickets(input([
      ticket('ORC-1', { labels: ['Harness'] }),
      ticket('ORC-2', { labels: ['Feature'] }),
      ticket('ORC-3', { labels: [] }),
      ticket('ORC-4', { labels: ['harness'] }),
    ])).rows;
    expect(rows.map((row) => [row.identifier, row.ticked, row.canTick])).toEqual([
      ['ORC-1', true, true], ['ORC-2', false, true], ['ORC-3', false, true], ['ORC-4', false, true],
    ]);
  });

  it('does not tick a ticket assigned to someone just because of who it is assigned to', () => {
    const row = only([ticket('ORC-1', { labels: [], assigneeName: 'James Example' })]);
    expect(row).toMatchObject({ ticked: false, canTick: true, notes: ['Assigned to James Example'] });
  });

  it('ticks nothing when no label is called "Harness", and says so', () => {
    const result = discoverTickets(input([ticket('ORC-1')], { harnessLabel: 'none' }));
    expect(result.rows[0]).toMatchObject({ ticked: false, canTick: true });
    expect(result.labelNote).toBe(NO_HARNESS_LABEL_NOTE);
  });

  it('ticks nothing when two labels are called "Harness", and says so', () => {
    const result = discoverTickets(input([ticket('ORC-1')], { harnessLabel: 'several' }));
    expect(result.rows[0]).toMatchObject({ ticked: false, canTick: true });
    expect(result.labelNote).toBe(SEVERAL_HARNESS_LABELS_NOTE);
  });

  it('gives no label note when there is one label', () => {
    expect(discoverTickets(input([ticket('ORC-1')])).labelNote).toBeNull();
  });
});

describe('why a ticket cannot be ticked', () => {
  it('a client team cannot be started yet, whatever its ticket carries', () => {
    const row = only([ticket('COM-1', { teamId: 'team-com', assigneeName: 'A Person' })]);
    expect(row).toMatchObject({ ticked: false, canTick: false, reason: CLIENT_TEAM_REASON, notes: [] });
    expect(CLIENT_TEAM_REASON).toBe('Client team. Starting client tickets arrives in a later step.');
  });

  it('a team with no saved rules is not ready, with the fixed reason', () => {
    const noRules: DiscoveryTeam = { teamId: 'team-orc', teamKey: 'ORC', ownership: null, ready: false, reasons: ['This team has no saved rules. Set them up on the Plan Queue page first.'] };
    expect(only([ticket('ORC-1')], { teams: [noRules] })).toMatchObject({
      canTick: false,
      ticked: false,
      reason: 'ORC is not ready: This team has no saved rules. Set them up on the Plan Queue page first.',
    });
  });

  it('a team with no allowed provider is not ready, with every reason it gave', () => {
    const team: DiscoveryTeam = { ...OWN, ready: false, reasons: ['No provider is allowed to see this team\'s ticket text.', 'Another problem.'] };
    expect(only([ticket('ORC-1')], { teams: [team] }).reason).toBe('ORC is not ready: No provider is allowed to see this team\'s ticket text. Another problem.');
  });

  it('a ticket of a team that was not read is not ready', () => {
    expect(only([ticket('ORC-1')], { teams: [] })).toMatchObject({ canTick: false, ticked: false });
  });

  it('a ticket an unfinished run holds is "Already in a run"', () => {
    const row = only([ticket('ORC-1')], { heldByUnfinishedRun: new Set(['uuid-ORC-1']) });
    expect(row).toMatchObject({ canTick: false, ticked: false, reason: ALREADY_IN_A_RUN_REASON });
    expect(ALREADY_IN_A_RUN_REASON).toBe('Already in a run');
  });

  it('shows a team that is not ready before a client team, and a client team before a held ticket', () => {
    const notReady: DiscoveryTeam = { ...CLIENT, ready: false, reasons: ['Nope.'] };
    expect(only([ticket('COM-1', { teamId: 'team-com' })], { teams: [notReady] }).reason).toBe('COM is not ready: Nope.');
    expect(only([ticket('COM-1', { teamId: 'team-com' })], { heldByUnfinishedRun: new Set(['uuid-COM-1']) }).reason).toBe(CLIENT_TEAM_REASON);
  });
});

describe('blockers', () => {
  it('a ticket blocked by one outside the list that is not done is waiting for it', () => {
    const row = only([ticket('ORC-1', { blockedBy: ['COM-123'] })], { blockers: new Map([['COM-123', { id: 'uuid-COM-123', statusKind: 'started' }]]) });
    expect(row).toMatchObject({ canTick: false, ticked: false, waitingFor: ['COM-123'], reason: 'Waiting for COM-123' });
  });

  it('names every blocker it waits for, once each', () => {
    const row = only([ticket('ORC-1', { blockedBy: ['COM-2', 'COM-1', 'COM-2'] })]);
    expect(row.waitingFor).toEqual(['COM-2', 'COM-1']);
    expect(row.reason).toBe('Waiting for COM-2, COM-1');
  });

  it('a blocker that could not be looked up counts as not done', () => {
    expect(only([ticket('ORC-1', { blockedBy: ['COM-9'] })]).reason).toBe('Waiting for COM-9');
  });

  it('a blocker outside the list whose status is completed does not hold the ticket', () => {
    const row = only([ticket('ORC-1', { blockedBy: ['ORC-99'] })], { blockers: new Map([['ORC-99', { id: 'uuid-ORC-99', statusKind: 'completed' }]]) });
    expect(row).toMatchObject({ canTick: true, ticked: true, waitingFor: [], notes: [] });
  });

  it('a blocker outside the list that Harness landed does not hold the ticket', () => {
    const row = only([ticket('ORC-1', { blockedBy: ['ORC-99'] })], {
      blockers: new Map([['ORC-99', { id: 'uuid-ORC-99', statusKind: 'started' }]]),
      landedBefore: new Map([['uuid-ORC-99', 1]]),
    });
    expect(row).toMatchObject({ canTick: true, waitingFor: [] });
  });

  it('a blocker in the list that is not done gives "Starts after", and the ticket can be ticked', () => {
    const rows = discoverTickets(input([ticket('ORC-11'), ticket('ORC-12', { blockedBy: ['ORC-11'] })])).rows;
    expect(rows[1]).toMatchObject({ identifier: 'ORC-12', canTick: true, ticked: true, waitingFor: [], notes: ['Starts after ORC-11'] });
  });

  it('a blocker in the list that Harness landed does not hold the ticket', () => {
    const rows = discoverTickets(input([ticket('ORC-11'), ticket('ORC-12', { blockedBy: ['ORC-11'] })], { landedBefore: new Map([['uuid-ORC-11', 1]]) })).rows;
    expect(rows[1].notes.filter((note) => note.startsWith('Starts after'))).toEqual([]);
  });

  it('a ticket that blocks itself is not held by itself', () => {
    expect(only([ticket('ORC-1', { blockedBy: ['ORC-1'] })])).toMatchObject({ canTick: true, waitingFor: [] });
  });
});

describe('what a ticket that can be ticked says', () => {
  it('names who it is assigned to', () => {
    expect(only([ticket('ORC-1', { assigneeName: 'Sam Example' })]).notes).toEqual(['Assigned to Sam Example']);
  });

  it('says Harness landed it before, and that Linear was not updated', () => {
    const landedAt = new Date(2026, 10, 14, 12, 0, 0).getTime();
    const row = only([ticket('ORC-1')], { landedBefore: new Map([['uuid-ORC-1', landedAt]]) });
    expect(row.notes).toEqual(['Harness landed this on 14 November. Its status in Linear has not been updated.']);
    expect(row.canTick).toBe(true);
  });

  it('gives every note that applies, in a fixed order', () => {
    const landedAt = new Date(2026, 10, 14, 12, 0, 0).getTime();
    const rows = discoverTickets(input(
      [ticket('ORC-11'), ticket('ORC-12', { assigneeName: 'Sam Example', blockedBy: ['ORC-11'] })],
      { landedBefore: new Map([['uuid-ORC-12', landedAt]]) },
    )).rows;
    expect(rows[1].notes).toEqual([
      'Assigned to Sam Example',
      'Starts after ORC-11',
      'Harness landed this on 14 November. Its status in Linear has not been updated.',
    ]);
  });

  it('says nothing about a ticket that cannot be ticked except why', () => {
    expect(only([ticket('COM-1', { teamId: 'team-com', assigneeName: 'A Person' })]).notes).toEqual([]);
  });
});

describe('what discovery reads', () => {
  it('has no description and no comments to read: its ticket and its rows carry neither', () => {
    const row = only([ticket('ORC-1')]);
    expect(Object.keys(row).sort()).toEqual([
      'assigneeName', 'canTick', 'id', 'identifier', 'labels', 'notes', 'priority', 'projectId', 'reason', 'teamId', 'ticked', 'title', 'waitingFor',
    ]);
  });

  it('does not change its input', () => {
    const tickets = [ticket('ORC-2'), ticket('ORC-1')];
    discoverTickets(input(tickets));
    expect(tickets.map((entry) => entry.identifier)).toEqual(['ORC-2', 'ORC-1']);
  });
});
