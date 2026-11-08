import { describe, expect, it } from 'vitest';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import type { TestMachineView, WorkToday } from '../../../../shared/types/computers.types';
import {
  buildComputerRows,
  changedChoices,
  describeNow,
  describeTakes,
  describeToday,
  movedChoices,
  TEST_MACHINE,
  THIS_MAC,
} from './computers-list.model';

const node = (id: string, change: Partial<RemoteNodeRosterEntry> = {}): RemoteNodeRosterEntry => ({
  id, name: id, status: 'connected', address: '', connected: true, supportedClis: [], hasBrowserRuntime: false,
  hasBrowserMcp: false, hasAndroidMcp: false, hasDocker: false, activeInstances: 0, maxConcurrentInstances: 10,
  workingDirectories: [],
  capabilities: {
    platform: 'win32', arch: 'x64', cpuCores: 16, totalMemoryMB: 1, availableMemoryMB: 1, supportedClis: [],
    hasBrowserRuntime: false, hasBrowserMcp: false, hasAndroidMcp: false, hasDocker: false, maxConcurrentInstances: 10,
    workingDirectories: [], browsableRoots: [], discoveredProjects: [],
  },
  ...change,
});
const machine = (change: Partial<TestMachineView> = {}): TestMachineView => ({
  host: 'harness-checks', platform: 'linux', label: 'the Windows PC', nodeName: 'windows-pc', paused: false, testRuns: true,
  checks: true, slots: 3, ...change,
});
const ON = { browser: true, android: true };

describe('the Computers list', () => {
  it('puts paired computers in the saved order, then new ones, then this Mac, with the test machine on its computer', () => {
    const rows = buildComputerRows(
      [node('laptop'), node('windows-pc', { hasBrowserMcp: true, hasAndroidMcp: true }), node('new')],
      [{ id: 'windows-pc', paused: false, sessions: true }, { id: 'laptop', paused: false, sessions: false }, { id: 'gone', paused: true, sessions: true }],
      [machine()],
      ON,
    );
    expect(rows.map(row => row.id)).toEqual(['windows-pc', 'laptop', 'new', THIS_MAC]);
    expect(rows[0]).toMatchObject({ testMachine: { label: 'the Windows PC' }, alsoTakes: ['browser work', 'Android work'] });
    expect(rows[1]).toMatchObject({ testMachine: null, choice: { sessions: false } });
    expect(rows[2]!.choice).toEqual({ id: 'new', paused: false, sessions: true });
  });

  it('shows a test machine with no paired computer as its own row, before this Mac', () => {
    const rows = buildComputerRows([node('laptop')], [], [machine({ nodeName: null })], ON);
    expect(rows.map(row => [row.id, row.name])).toEqual([
      ['laptop', 'laptop'], [`${TEST_MACHINE}:harness-checks`, 'the Windows PC'], [THIS_MAC, 'This Mac'],
    ]);
  });

  it('puts each of several test machines on its own computer or its own row, in the file\'s order', () => {
    const testMac = machine({ host: 'ct-test-mac', platform: 'darwin', label: 'the test Mac', nodeName: null });
    const spare = machine({ host: 'spare', label: 'the spare', nodeName: 'windows-pc' });
    const rows = buildComputerRows([node('windows-pc'), node('laptop')], [], [machine(), testMac, spare], ON);
    expect(rows.map(row => [row.id, row.testMachine?.host ?? null])).toEqual([
      ['windows-pc', 'harness-checks'],
      ['laptop', null],
      [`${TEST_MACHINE}:ct-test-mac`, 'ct-test-mac'],
      [`${TEST_MACHINE}:spare`, 'spare'],
      [THIS_MAC, null],
    ]);
  });

  it('leaves out browser and Android work when their switches are off', () => {
    const [row] = buildComputerRows([node('pc', { hasBrowserMcp: true, hasAndroidMcp: true })], [], [], { browser: false, android: true });
    expect(row!.alsoTakes).toEqual(['Android work']);
  });

  it('calls a computer paused when either its own choice or its test machine is paused', () => {
    expect(buildComputerRows([node('windows-pc')], [], [machine({ paused: true })], ON)[0]!.paused).toBe(true);
    expect(buildComputerRows([node('windows-pc')], [{ id: 'windows-pc', paused: true, sessions: true }], [machine()], ON)[0]!.paused).toBe(true);
  });

  it('moves a computer one place and saves every paired computer in the new order', () => {
    const rows = buildComputerRows([node('a'), node('b'), node('c')], [], [], ON);
    expect(movedChoices(rows, 'c', -1).map(choice => choice.id)).toEqual(['a', 'c', 'b']);
    expect(movedChoices(rows, 'a', -1).map(choice => choice.id)).toEqual(['a', 'b', 'c']);
    expect(movedChoices(rows, 'c', 1).map(choice => choice.id)).toEqual(['a', 'b', 'c']);
    expect(movedChoices(rows, THIS_MAC, -1).map(choice => choice.id)).toEqual(['a', 'b', 'c']);
  });

  it('changes one computer and keeps the rest as they were', () => {
    const rows = buildComputerRows([node('a'), node('b')], [{ id: 'b', paused: false, sessions: false }], [], ON);
    expect(changedChoices(rows, 'a', { paused: true })).toEqual([
      { id: 'b', paused: false, sessions: false },
      { id: 'a', paused: true, sessions: true },
    ]);
  });

  it('says nothing about a computer that is up and idle, and says what is different otherwise', () => {
    const now = new Date(2026, 10, 7, 15, 0).getTime();
    const [idle, busy, away, earlier] = buildComputerRows([
      node('idle'),
      node('busy', { activeInstances: 2 }),
      node('away', { connected: false, lastHeartbeat: new Date(2026, 10, 7, 14, 2).getTime() }),
      node('earlier', { connected: false, lastHeartbeat: new Date(2026, 10, 5, 9, 0).getTime() }),
    ], [], [], ON);
    expect(describeNow(idle!, now)).toBeNull();
    expect(describeNow(busy!, now)).toBe('2 sessions running');
    expect(describeNow(away!, now)).toBe('Away since 14:02');
    expect(describeNow(earlier!, now)).toBe('Away since 5 Nov');
    expect(describeNow({ ...busy!, paused: true }, now)).toBe('Paused');
  });

  it('puts today\'s work into sentences, and says so when nothing has run', () => {
    const today: WorkToday = {
      testRuns: { there: 59, here: 8 }, checks: { there: 0, here: 0 }, shortRunsHere: 140,
      hereBecause: [{ reason: 'the Windows PC is paused', count: 8 }],
    };
    expect(describeToday(today, 'the Windows PC')).toEqual([
      'Test runs: 59 on the Windows PC, 8 here.',
      'Short test runs here: 140. They finish sooner on this Mac than they would there.',
      '8 ran here because the Windows PC is paused.',
    ]);
    expect(describeToday({ testRuns: { there: 0, here: 0 }, checks: { there: 0, here: 0 }, shortRunsHere: 0, hereBecause: [] }, 'x'))
      .toEqual(['Nothing has run today.']);
  });
});

describe('what a computer takes, in words', () => {
  it('lists the kinds of work it takes, with how many test runs at once', () => {
    const [laptop, mac, pc] = buildComputerRows(
      [node('windows-pc', { hasBrowserMcp: true }), node('laptop')],
      [{ id: 'laptop', paused: false, sessions: false }],
      [machine({ checks: false, slots: 4 })],
      ON,
    ).sort((a, b) => a.id.localeCompare(b.id));
    expect(describeTakes(laptop!)).toBe('Takes nothing.');
    expect(describeTakes(mac!)).toBe('Takes anything the others can\'t, and work that needs this Mac.');
    expect(describeTakes(pc!)).toBe('Takes agent sessions, test runs and browser work, 4 test runs or checks at once.');
  });
});
