/**
 * The Computers list: paired computers in the order Harness tries them, test machines that belong to none of them,
 * and this Mac last. Pure, so the order, the moves and the words can be tested without a screen.
 */
import type { ComputerChoice } from '../../../../shared/types/settings.types';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import type { TestMachineView, WorkToday } from '../../../../shared/types/computers.types';

export const THIS_MAC = 'this-mac';
/** A test machine's row when it belongs to no paired computer here: `test-machine:` and its host. */
export const TEST_MACHINE = 'test-machine';

export interface ComputerRow {
  id: string;
  kind: 'paired' | 'test-machine' | 'this-mac';
  name: string;
  /** Not connected now. Unknown for a test machine, which is only reached when work goes to it. */
  away: boolean;
  /** When it was last heard from, if it's away and that's known. */
  awaySince: number | null;
  sessionsRunning: number;
  /** A paired computer's choices; the defaults until it's first changed. */
  choice: ComputerChoice | null;
  /** The test machine, when this row is it or it's part of this computer. */
  testMachine: TestMachineView | null;
  paused: boolean;
  /** Other work it takes through the Advanced switches, in words. */
  alsoTakes: string[];
}

export interface OffloadSwitches { browser: boolean; android: boolean }

export function defaultChoice(id: string): ComputerChoice {
  return { id, paused: false, sessions: true };
}

/**
 * Paired computers in the saved order, then any not yet in it; then test machines that belong to none of them, in the
 * file's order; then this Mac. A test machine goes with the first paired computer whose name its file gives, so two
 * computers with one name share none, and a computer has at most one.
 */
export function buildComputerRows(
  nodes: readonly RemoteNodeRosterEntry[],
  choices: readonly ComputerChoice[],
  testMachines: readonly TestMachineView[],
  offload: OffloadSwitches,
): ComputerRow[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const listed = choices.filter(choice => byId.has(choice.id)).map(choice => byId.get(choice.id)!);
  const ordered = [...listed, ...nodes.filter(node => !choices.some(choice => choice.id === node.id))];
  const owned = new Map<RemoteNodeRosterEntry, TestMachineView>();
  for (const machine of testMachines) {
    const owner = machine.nodeName ? ordered.find(node => node.name === machine.nodeName && !owned.has(node)) : undefined;
    if (owner) owned.set(owner, machine);
  }

  const rows: ComputerRow[] = ordered.map((node) => {
    const choice = choices.find(entry => entry.id === node.id) ?? defaultChoice(node.id);
    const machine = owned.get(node) ?? null;
    const alsoTakes = [
      ...(offload.browser && node.hasBrowserMcp ? ['browser work'] : []),
      ...(offload.android && node.hasAndroidMcp ? ['Android work'] : []),
    ];
    return {
      id: node.id,
      kind: 'paired',
      name: node.name,
      away: !node.connected,
      awaySince: node.connected ? null : node.lastHeartbeat ?? null,
      sessionsRunning: node.activeInstances,
      choice,
      testMachine: machine,
      paused: choice.paused || machine?.paused === true,
      alsoTakes,
    };
  });
  const ownedMachines = new Set(owned.values());
  for (const machine of testMachines.filter(entry => !ownedMachines.has(entry))) {
    rows.push({
      id: `${TEST_MACHINE}:${machine.host}`, kind: 'test-machine', name: machine.label, away: false, awaySince: null,
      sessionsRunning: 0, choice: null, testMachine: machine, paused: machine.paused, alsoTakes: [],
    });
  }
  rows.push({
    id: THIS_MAC, kind: 'this-mac', name: 'This Mac', away: false, awaySince: null, sessionsRunning: 0,
    choice: null, testMachine: null, paused: false, alsoTakes: [],
  });
  return rows;
}

/** Every paired computer's choice, in the list's order, so the saved order is complete after any change. */
function pairedChoices(rows: readonly ComputerRow[]): ComputerChoice[] {
  return rows.filter(row => row.kind === 'paired').map(row => ({ ...row.choice! }));
}

/** The saved choices after moving a paired computer one place up (-1) or down (1). Unchanged at either end. */
export function movedChoices(rows: readonly ComputerRow[], id: string, by: -1 | 1): ComputerChoice[] {
  const choices = pairedChoices(rows);
  const from = choices.findIndex(choice => choice.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= choices.length) return choices;
  [choices[from], choices[to]] = [choices[to]!, choices[from]!];
  return choices;
}

/** The saved choices with one paired computer's changed. */
export function changedChoices(rows: readonly ComputerRow[], id: string, change: Partial<Omit<ComputerChoice, 'id'>>): ComputerChoice[] {
  return pairedChoices(rows).map(choice => (choice.id === id ? { ...choice, ...change } : choice));
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "Away since 14:02", or "Away since 5 Nov" when it wasn't today. */
export function describeAway(row: ComputerRow, now: number): string | null {
  if (!row.away) return null;
  if (row.awaySince === null) return 'Away';
  const since = new Date(row.awaySince);
  const when = sameDay(since, new Date(now))
    ? since.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : since.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `Away since ${when}`;
}

/** What it's doing, in words. Nothing for a computer that is up and idle. */
export function describeNow(row: ComputerRow, now: number): string | null {
  if (row.paused) return 'Paused';
  const away = describeAway(row, now);
  if (away) return away;
  if (row.sessionsRunning > 0) return `${row.sessionsRunning} ${row.sessionsRunning === 1 ? 'session' : 'sessions'} running`;
  return null;
}

/** Today's work in sentences, naming the test machine as people do. */
export function describeToday(today: WorkToday, label: string): string[] {
  const where = (counts: { there: number; here: number }) => `${counts.there} on ${label}, ${counts.here} here`;
  const lines = [
    ...(today.testRuns.there + today.testRuns.here > 0 ? [`Test runs: ${where(today.testRuns)}.`] : []),
    ...(today.checks.there + today.checks.here > 0 ? [`Checks: ${where(today.checks)}.`] : []),
    ...(today.shortRunsHere > 0
      ? [`Short test runs here: ${today.shortRunsHere}. They finish sooner on this Mac than they would there.`]
      : []),
    ...today.hereBecause.map(({ reason, count }) => `${count} ran here because ${reason}.`),
  ];
  return lines.length ? lines : ['Nothing has run today.'];
}

/** What a computer takes, for the read-only list. */
export function describeTakes(row: ComputerRow): string {
  if (row.kind === 'this-mac') return 'Takes anything the others can\'t, and work that needs this Mac.';
  const kinds = [
    ...(row.choice?.sessions ? ['agent sessions'] : []),
    ...(row.testMachine?.testRuns ? ['test runs'] : []),
    ...(row.testMachine?.checks ? ['checks'] : []),
    ...row.alsoTakes,
  ];
  if (!kinds.length) return 'Takes nothing.';
  const list = kinds.length === 1 ? kinds[0]! : `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)!}`;
  const room = row.testMachine && (row.testMachine.testRuns || row.testMachine.checks) ? `, ${row.testMachine.slots} test runs or checks at once` : '';
  return `Takes ${list}${room}.`;
}
