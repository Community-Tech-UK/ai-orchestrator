/**
 * The Computers list: paired computers in the order Harness tries them, test machines that belong to none of them,
 * and this Mac last. Pure, so the order, the moves and the words can be tested without a screen.
 */
import type { CanonicalCliType, ComputerChoice } from '../../../../shared/types/settings.types';
import type { NodePlatform, RemoteNodeRosterEntry, WorkerNodeSignIn } from '../../../../shared/types/worker-node.types';
import type { TestMachineView, WorkToday } from '../../../../shared/types/computers.types';
import { LEGACY_ACCOUNT_PROFILE_ID } from '../../../../shared/types/provider-account.types';
import { providerName } from '../../../../shared/display-names';
import { servicePaths } from '../../../../shared/service/worker-service-paths';

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
  /** What a connected paired computer reported about its AI tools and folders. Null for every other row. */
  detail: ComputerDetail | null;
}

export interface ComputerDetail {
  platform: NodePlatform;
  tools: readonly CanonicalCliType[];
  /** Null until the computer's helper has checked, or when it is too old to check. */
  signIns: readonly WorkerNodeSignIn[] | null;
  folders: readonly string[];
  projectCount: number;
}

/** One line about a computer's AI tools. `command` is what to run on that computer, shown as code. */
export interface DetailLine { text: string; command?: string }

/** A saved account's name here, if this Mac has one for it. */
export type AccountLabel = (provider: WorkerNodeSignIn['provider'], profileId: string) => string | undefined;

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
      detail: node.connected ? detailOf(node) : null,
    };
  });
  const ownedMachines = new Set(owned.values());
  for (const machine of testMachines.filter(entry => !ownedMachines.has(entry))) {
    rows.push({
      id: `${TEST_MACHINE}:${machine.host}`, kind: 'test-machine', name: machine.label, away: false, awaySince: null,
      sessionsRunning: 0, choice: null, testMachine: machine, paused: machine.paused, alsoTakes: [], detail: null,
    });
  }
  rows.push({
    id: THIS_MAC, kind: 'this-mac', name: 'This Mac', away: false, awaySince: null, sessionsRunning: 0,
    choice: null, testMachine: null, paused: false, alsoTakes: [], detail: null,
  });
  return rows;
}

function detailOf(node: RemoteNodeRosterEntry): ComputerDetail {
  const caps = node.capabilities;
  return {
    platform: caps.platform,
    tools: caps.supportedClis,
    signIns: caps.signIns ?? null,
    folders: caps.workingDirectories,
    projectCount: caps.discoveredProjects.length,
  };
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
    ...(today.iphone.there + today.iphone.here > 0 ? [`iPhone builds and simulators: ${where(today.iphone)}.`] : []),
    ...(today.shortRunsHere > 0
      ? [`Short test runs here: ${today.shortRunsHere}. They finish sooner on this Mac than they would there.`]
      : []),
    ...today.hereBecause.map(({ reason, count }) => `${count} ran here because ${reason}.`),
  ];
  return lines.length ? lines : ['Nothing has run today.'];
}

/** What a computer takes, for the read-only list. */
export function describeTakes(row: ComputerRow, useThisMac = true): string {
  if (row.kind === 'this-mac') {
    return useThisMac
      ? 'Takes anything the others can\'t, and work that needs this Mac.'
      : 'Takes only work that needs this Mac. Other work waits for the other computers.';
  }
  const kinds = [
    ...(row.choice?.sessions ? ['agent sessions'] : []),
    ...(row.testMachine?.testRuns ? ['test runs'] : []),
    ...(row.testMachine?.checks ? ['checks'] : []),
    ...row.alsoTakes,
  ];
  if (!kinds.length) return 'Takes nothing.';
  const list = listInWords(kinds);
  const room = row.testMachine && (row.testMachine.testRuns || row.testMachine.checks) ? `, ${row.testMachine.slots} test runs or checks at once` : '';
  return `Takes ${list}${room}.`;
}

/** "a, b and c". */
function listInWords(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`;
}

const SIGN_IN_COMMAND: Record<WorkerNodeSignIn['provider'], string> = { claude: 'claude auth login', codex: 'codex login' };

/**
 * The AI tools a computer has, and for Claude and Codex whether each account is signed in there, as that computer
 * last checked. A default sign-in that is missing comes with the command that fixes it; any other account is named,
 * by this Mac's name for it when there is one.
 */
export function describeTools(detail: ComputerDetail, accountLabel: AccountLabel): DetailLine[] {
  if (!detail.tools.length) return [{ text: 'No AI tools were found there, so it can\'t take agent sessions.' }];
  const lines: DetailLine[] = [{ text: `AI tools there: ${listInWords(detail.tools.map(tool => providerName(tool)))}.` }];
  const checked = (['claude', 'codex'] as const).filter(tool => detail.tools.includes(tool));
  if (!checked.length) return lines;
  if (!detail.signIns) {
    return [...lines, { text: 'Its sign-ins haven\'t been checked yet. If this doesn\'t change within a few minutes, update Harness on that computer.' }];
  }
  const signIns = detail.signIns.filter(sign => checked.includes(sign.provider));
  for (const entry of signIns) {
    const tool = providerName(entry.provider);
    const isDefault = entry.profileId === LEGACY_ACCOUNT_PROFILE_ID;
    const who = isDefault ? tool : `${tool} account ${accountLabel(entry.provider, entry.profileId) ?? entry.profileId}`;
    if (entry.state === 'signed-in') {
      lines.push({ text: entry.identity ? `${who} is signed in as ${entry.identity}.` : `${who} is signed in.` });
    } else if (entry.state === 'unknown') {
      lines.push({ text: `${who}: its sign-in couldn't be read there.` });
    } else if (isDefault) {
      lines.push({ text: `${who} isn't signed in. To sign in, run this on that computer:`, command: SIGN_IN_COMMAND[entry.provider] });
    } else {
      lines.push({ text: `${who} isn't signed in there.` });
    }
  }
  if (signIns.some(entry => entry.state !== 'signed-in')) {
    lines.push({ text: 'Computers check their sign-ins every 10 minutes, so a new one can take that long to show here.' });
  }
  return lines;
}

/** The tools whose extra accounts a computer reports, so this Mac's names are read only for those. */
export function providersWithAccounts(rows: readonly ComputerRow[]): WorkerNodeSignIn['provider'][] {
  const providers = rows.flatMap(row => row.detail?.signIns ?? [])
    .filter(entry => entry.profileId !== LEGACY_ACCOUNT_PROFILE_ID)
    .map(entry => entry.provider);
  return [...new Set(providers)];
}

/** The folders a computer opens, and how many projects it found in them. */
export function describeFolders(detail: ComputerDetail): string {
  if (!detail.folders.length) return 'It opens no folders, so no session can run there.';
  const projects = detail.projectCount === 1 ? '1 project' : `${detail.projectCount} projects`;
  return `Opens folders in ${listInWords(detail.folders)}, with ${projects} found there.`;
}

/**
 * Where a computer's worker keeps its folder list: in the home folder there, or the system-wide file when it runs as a
 * service (`src/worker-agent/index.ts` reads the service file in service mode).
 */
export function workerSettingsFiles(platform: NodePlatform): { home: string; service: string } {
  return {
    home: platform === 'win32' ? '.orchestrator\\worker-node.json' : '.orchestrator/worker-node.json',
    service: servicePaths(platform).configFile,
  };
}

/** One step of setting a computer up for tests and checks. `command` is what to run or write, shown as code. */
export interface SetupStep { text: string; command?: string }

/** Where this Mac keeps the test machine list and the key it connects with. */
const REMOTE_CHECKS_DIR = '~/.ai-orchestrator/remote-checks';

/** A list entry as JSON, so a name with a quote or backslash in it still gives a file that parses. */
function configEntry(entry: Record<string, string>): string {
  return `{ ${Object.entries(entry).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(', ')} }`;
}

/**
 * What it takes to make a paired computer a test machine, in order. It needs a Linux space to run in (the machine's
 * own Linux, or Ubuntu inside Windows), the setup script that ships in this project, and a line in the list that says
 * which paired computer it belongs to. A paired Mac needs no script: its tools come from Homebrew. Only called for a
 * paired computer that has no test machine yet.
 */
export function describeSetup(row: ComputerRow): SetupStep[] {
  const platform = row.detail?.platform;
  if (platform === 'darwin') {
    return [
      { text: 'On that Mac, switch on Remote Login (System Settings, General, Sharing) and add this Mac\'s key to its authorized keys. The key is the file ending .pub in:', command: REMOTE_CHECKS_DIR },
      { text: 'On this Mac, give it a short name for connecting by adding a Host entry for it to:', command: '~/.ssh/config' },
      { text: 'On that Mac, install the two tools the tests need:', command: 'brew install ripgrep flock' },
      { text: `On this Mac, add it to the list in ${REMOTE_CHECKS_DIR}/config.json, under "moreMachines":`, command: configEntry({ host: '<its short name>', label: `the ${row.name} Mac`, platform: 'darwin', nodeName: row.name }) },
    ];
  }
  const where = platform === 'win32'
    ? 'On that computer, open Ubuntu 24.04 (Windows can add it with "wsl --install -d Ubuntu-24.04").'
    : 'On that computer, open a terminal on Ubuntu 24.04.';
  return [
    { text: where },
    { text: `Run the setup script from this project there as the administrator, giving it this Mac's key (the file ending .pub in ${REMOTE_CHECKS_DIR}):`, command: 'sudo bash scripts/remote-checks/setup-linux.sh "<this Mac\'s public key>"' },
    { text: `On this Mac, give it a short name for connecting: add a Host entry (its address, Port 2222, User checks and the key) to ${REMOTE_CHECKS_DIR}/ssh_config.` },
    { text: `Then add the computer to the list in ${REMOTE_CHECKS_DIR}/config.json, under "moreMachines" (or as the file itself when it's the first):`, command: configEntry({ host: '<its short name>', label: `the ${row.name}`, sshConfig: `${REMOTE_CHECKS_DIR}/ssh_config`, nodeName: row.name }) },
  ];
}

/** Whether to offer the setup steps: a paired computer with no test machine yet. */
export function offersSetup(row: ComputerRow): boolean {
  return row.kind === 'paired' && row.testMachine === null;
}
