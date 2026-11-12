import { describe, expect, it } from 'vitest';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import type { TestMachineView, WorkToday } from '../../../../shared/types/computers.types';
import {
  buildComputerRows,
  changedChoices,
  describeFolders,
  describeNow,
  describeSetup,
  describeTools,
  offersSetup,
  providersWithAccounts,
  workerSettingsFiles,
  type ComputerDetail,
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
      testRuns: { there: 59, here: 8 }, checks: { there: 0, here: 0 }, iphone: { there: 0, here: 0 }, shortRunsHere: 140,
      hereBecause: [{ reason: 'the Windows PC is paused', count: 8 }],
    };
    expect(describeToday(today, 'the Windows PC')).toEqual([
      'Test runs: 59 on the Windows PC, 8 here.',
      'Short test runs here: 140. They finish sooner on this Mac than they would there.',
      '8 ran here because the Windows PC is paused.',
    ]);
    // iPhone work only goes to a test Mac, so it shows with several test machines, named together.
    expect(describeToday({ ...today, testRuns: { there: 0, here: 0 }, shortRunsHere: 0, hereBecause: [], iphone: { there: 3, here: 1 } }, 'your test machines'))
      .toEqual(['iPhone builds and simulators: 3 on your test machines, 1 here.']);
    expect(describeToday({
      testRuns: { there: 0, here: 0 }, checks: { there: 0, here: 0 }, iphone: { there: 0, here: 0 }, shortRunsHere: 0, hereBecause: [],
    }, 'x'))
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

describe('a computer\'s AI tools and folders, in words', () => {
  const caps = node('pc').capabilities;
  const detail = (change: Partial<ComputerDetail> = {}): ComputerDetail => ({
    platform: 'win32', tools: ['claude', 'codex', 'copilot'], signIns: null, folders: ['C:\\Work'], projectCount: 3, ...change,
  });
  const noLabels = () => undefined;

  it('comes from a connected paired computer only', () => {
    const [up, away, mac] = buildComputerRows([
      node('up', { capabilities: { ...caps, supportedClis: ['codex'], workingDirectories: ['C:\\Work'],
        discoveredProjects: [{ path: 'C:\\Work\\a', name: 'a', markers: [] }],
        signIns: [{ provider: 'codex', profileId: 'legacy', state: 'signed-in' }] } }),
      node('away', { connected: false }),
    ], [], [], ON);
    expect(up!.detail).toEqual({
      platform: 'win32', tools: ['codex'], signIns: [{ provider: 'codex', profileId: 'legacy', state: 'signed-in' }],
      folders: ['C:\\Work'], projectCount: 1,
    });
    expect(away!.detail).toBeNull();
    expect(mac!.detail).toBeNull();
  });

  it('says each default sign-in, with the command when one is missing, and names other accounts', () => {
    const lines = describeTools(detail({
      signIns: [
        { provider: 'claude', profileId: 'legacy', state: 'signed-in', identity: 'person@example.invalid' },
        { provider: 'claude', profileId: 'work', state: 'signed-out' },
        { provider: 'claude', profileId: 'spare', state: 'unknown' },
        { provider: 'codex', profileId: 'legacy', state: 'signed-out' },
      ],
    }), (provider, id) => (provider === 'claude' && id === 'work' ? 'Comtech' : undefined));
    expect(lines).toEqual([
      { text: 'AI tools there: Claude, Codex and Copilot.' },
      { text: 'Claude is signed in as person@example.invalid.' },
      { text: 'Claude account Comtech isn\'t signed in there.' },
      { text: 'Claude account spare: its sign-in couldn\'t be read there.' },
      { text: 'Codex isn\'t signed in. To sign in, run this on that computer:', command: 'codex login' },
      { text: 'Computers check their sign-ins every 10 minutes, so a new one can take that long to show here.' },
    ]);
    expect(describeTools(detail({ tools: ['codex'], signIns: [{ provider: 'codex', profileId: 'legacy', state: 'signed-in' }] }), noLabels))
      .toEqual([{ text: 'AI tools there: Codex.' }, { text: 'Codex is signed in.' }]);
  });

  it('asks for this Mac\'s account names only for tools another computer reports extra accounts for', () => {
    const withSignIns = (id: string, signIns: ComputerDetail['signIns']) =>
      node(id, { capabilities: { ...caps, supportedClis: ['claude', 'codex'], ...(signIns ? { signIns: [...signIns] } : {}) } });
    const rows = buildComputerRows([
      withSignIns('a', [{ provider: 'claude', profileId: 'legacy', state: 'signed-in' }, { provider: 'codex', profileId: 'legacy', state: 'signed-out' }]),
      withSignIns('b', null),
    ], [], [], ON);
    expect(providersWithAccounts(rows)).toEqual([]);
    const more = buildComputerRows([
      withSignIns('a', [{ provider: 'codex', profileId: 'work', state: 'signed-in' }]),
      withSignIns('b', [{ provider: 'codex', profileId: 'spare', state: 'signed-out' }]),
    ], [], [], ON);
    expect(providersWithAccounts(more)).toEqual(['codex']);
  });

  it('says when sign-ins haven\'t been checked, and doesn\'t ask about tools it can\'t check', () => {
    expect(describeTools(detail(), noLabels).at(-1)).toEqual({
      text: 'Its sign-ins haven\'t been checked yet. If this doesn\'t change within a few minutes, update Harness on that computer.',
    });
    expect(describeTools(detail({ tools: ['copilot'] }), noLabels)).toEqual([{ text: 'AI tools there: Copilot.' }]);
    expect(describeTools(detail({ tools: [] }), noLabels)).toEqual([
      { text: 'No AI tools were found there, so it can\'t take agent sessions.' },
    ]);
  });

  it('names the folders it opens, and where to add one on that computer', () => {
    expect(describeFolders(detail())).toBe('Opens folders in C:\\Work, with 3 projects found there.');
    expect(describeFolders(detail({ folders: ['/a', '/b'], projectCount: 1 }))).toBe('Opens folders in /a and /b, with 1 project found there.');
    expect(describeFolders(detail({ folders: [] }))).toBe('It opens no folders, so no session can run there.');
    expect(workerSettingsFiles('win32')).toEqual({
      home: '.orchestrator\\worker-node.json', service: 'C:\\ProgramData\\Orchestrator\\worker-node.json',
    });
    expect(workerSettingsFiles('darwin')).toEqual({
      home: '.orchestrator/worker-node.json', service: '/Library/Application Support/Orchestrator/worker-node.json',
    });
  });
});

describe('setting a paired computer up for tests and checks', () => {
  const rowFor = (id: string, platform: 'win32' | 'darwin' | 'linux' | null, machines: TestMachineView[] = []) => {
    const base = node(id);
    const paired = platform ? node(id, { capabilities: { ...base.capabilities, platform } }) : node(id, { connected: false });
    return buildComputerRows([paired], [], machines, ON).find(row => row.id === id)!;
  };

  it('is offered for a paired computer with no test machine, and for nothing else', () => {
    expect(offersSetup(rowFor('laptop', 'linux'))).toBe(true);
    expect(offersSetup(rowFor('windows-pc', 'win32', [machine()]))).toBe(false);
    const rows = buildComputerRows([node('laptop')], [], [machine({ nodeName: null })], ON);
    expect(rows.filter(offersSetup).map(row => row.id)).toEqual(['laptop']);
  });

  it('gives a Windows computer the Ubuntu, setup script and list steps, naming the computer it belongs to', () => {
    const steps = describeSetup(rowFor('dell', 'win32'));
    expect(steps).toHaveLength(4);
    expect(steps[0]!.text).toContain('Ubuntu 24.04');
    expect(steps[1]!.command).toContain('setup-linux.sh');
    expect(steps[3]!.command).toContain('"nodeName": "dell"');
    expect(steps[3]!.text).toContain('moreMachines');
    expect(steps.every(step => !step.command?.includes('darwin'))).toBe(true);
  });

  it('gives a Mac the Homebrew tools instead of the script, and marks the entry as a Mac', () => {
    const steps = describeSetup(rowFor('studio', 'darwin'));
    const commands = steps.map(step => step.command ?? '');
    expect(commands).toContain('brew install ripgrep flock');
    expect(commands.some(command => command.includes('setup-linux.sh'))).toBe(false);
    expect(commands.at(-1)).toContain('"platform": "darwin"');
    expect(commands.at(-1)).toContain('"nodeName": "studio"');
  });

  it('gives entries that parse as JSON even when the computer\'s name has quotes or backslashes in it', () => {
    const name = 'James\'s "Laptop" \\ den';
    for (const platform of ['win32', 'darwin'] as const) {
      const entry = describeSetup(rowFor(name, platform)).at(-1)!.command!;
      expect(JSON.parse(entry)).toMatchObject({ nodeName: name });
      expect(JSON.parse(entry).label).toContain(name);
    }
  });

  it('still gives steps for a computer that is away, treating it as Linux', () => {
    expect(describeSetup(rowFor('laptop', null)).some(step => step.command?.includes('setup-linux.sh'))).toBe(true);
  });
});
