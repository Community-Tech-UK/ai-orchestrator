import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

interface MacTurn { release(): void; note: string | null }
const require = createRequire(import.meta.url);
const { MAC_ONLY_SPECS, mergeMacOnlyReport } = require('./mac-only.js') as {
  MAC_ONLY_SPECS: string[];
  mergeMacOnlyReport(options: { mainPath: string; macPath: string; root: string; macExitCode: number }): void;
};
const { takeMacTurn } = require('./mac-turn.js') as {
  takeMacTurn(options: {
    dir: string; isLoop: boolean; log: (line: string) => void; waitLimitMs?: number; noticeIntervalMs?: number;
  }): Promise<MacTurn>;
};
interface Machine { host: string; label: string; platform: string; paused: boolean; testRuns: boolean; checks: boolean; slots: number }
interface Config { queueChecks: boolean; machines: Machine[] }
const { appendRunLog, decideRoute, isLoopRun, isQueueCheck, machinesFor, readConfig } = require('./route.js') as {
  appendRunLog(entry: object, env?: NodeJS.ProcessEnv): void;
  decideRoute(options: { args: string[]; env?: NodeJS.ProcessEnv; root: string; config: Config | null }): object;
  isLoopRun(env?: NodeJS.ProcessEnv): boolean;
  isQueueCheck(root: string, env?: NodeJS.ProcessEnv): boolean;
  machinesFor(config: Config, work: 'testRuns' | 'checks'): Machine[];
  readConfig(env?: NodeJS.ProcessEnv): Config | null;
};

const temps: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-checks-spec-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const machine = (change: Partial<Machine> = {}): Machine => ({
  host: 'harness-checks', label: 'the PC', platform: 'linux', paused: false, testRuns: true, checks: true, slots: 3, ...change,
});
const config: Config = { queueChecks: false, machines: [machine()] };
/** The config with its one machine changed. */
const withMachine = (change: Partial<Machine>): Config => ({ ...config, machines: [machine(change)] });
const root = '/work/repo';
const route = (args: string[], env: NodeJS.ProcessEnv = {}, at = root, withConfig: Config | null = config) =>
  decideRoute({ args, env, root: at, config: withConfig });

describe('decideRoute', () => {
  it('sends a plain full run, including from a loop, which Harness marks with CI=1', () => {
    expect(route([])).toEqual({ kind: 'remote', turn: true });
    expect(route(['--no-cache'])).toEqual({ kind: 'remote', turn: true });
    expect(route([], { CI: '1' })).toEqual({ kind: 'remote', turn: true });
  });

  it('changes nothing with no config, on GitHub, or for anything but a plain full run', () => {
    expect(route([], {}, root, null)).toEqual({ kind: 'local' });
    expect(route([], { GITHUB_ACTIONS: 'true' })).toEqual({ kind: 'local' });
    for (const args of [['src/a.spec.ts'], ['-u'], ['--coverage'], ['--project', 'main'], ['--changed'], ['--shard=1/4']]) {
      expect(route(args)).toEqual({ kind: 'local' });
    }
  });

  it('honours AIO_REMOTE_CHECKS=off, and still takes a turn on the Mac', () => {
    expect(route([], { AIO_REMOTE_CHECKS: 'off' })).toMatchObject({ kind: 'mac', turn: true });
  });

  it('keeps queue checks on the Mac, with no turn, until the config moves them', () => {
    const queueFolder = '/work/repo/.worktrees/queue/item-1';
    expect(route([], {}, queueFolder)).toMatchObject({ kind: 'mac', turn: false });
    expect(route([], {}, queueFolder, { ...config, queueChecks: true })).toEqual({ kind: 'remote', turn: false });
  });

  it('keeps work here, saying why, when the machine is paused or test runs are turned off for it', () => {
    expect(route([], {}, root, withMachine({ paused: true }))).toEqual({ kind: 'mac', turn: true, reason: 'the PC is paused' });
    expect(route([], {}, root, withMachine({ testRuns: false }))).toEqual({
      kind: 'mac', turn: true, reason: 'test runs are turned off for the PC',
    });
    expect(route([], {}, root, withMachine({ checks: false }))).toEqual({ kind: 'remote', turn: true });
    const queueFolder = '/work/repo/.worktrees/queue/item-1';
    expect(route([], {}, queueFolder, { ...withMachine({ paused: true }), queueChecks: true })).toMatchObject({ kind: 'mac', turn: false });
    const specs = Array.from({ length: 50 }, (_, index) => `src/s${index}.spec.ts`);
    expect(route(specs, {}, root, withMachine({ paused: true }))).toEqual({ kind: 'local' });
  });

  it('goes out while any machine takes the work, and stays here naming every machine\'s reason when none does', () => {
    const two = (first: Partial<Machine>, second: Partial<Machine>): Config => ({
      queueChecks: false, machines: [machine(first), machine({ host: 'ct-test-mac', label: 'the test Mac', platform: 'darwin', ...second })],
    });
    expect(route([], {}, root, two({ paused: true }, {}))).toEqual({ kind: 'remote', turn: true });
    expect(machinesFor(two({ paused: true }, {}), 'testRuns').map(entry => entry.host)).toEqual(['ct-test-mac']);
    expect(machinesFor(two({}, {}), 'checks').map(entry => entry.host)).toEqual(['harness-checks', 'ct-test-mac']);
    expect(route([], {}, root, two({ paused: true }, { testRuns: false }))).toEqual({
      kind: 'mac', turn: true, reason: 'the PC is paused and test runs are turned off for the test Mac',
    });
  });

  describe('a long list of spec files', () => {
    const specs = Array.from({ length: 50 }, (_, index) => `src/s${index}.spec.ts`);

    it('goes to the far machine, with no turn on the Mac, once it reaches the limit', () => {
      expect(route(specs)).toEqual({ kind: 'remote', turn: false, specs });
      expect(route(specs.slice(1))).toEqual({ kind: 'local' });
    });

    it('stays as it always was with anything else on the command line', () => {
      expect(route([...specs, '-u'])).toEqual({ kind: 'local' });
      expect(route([...specs.slice(1), 'src/main'])).toEqual({ kind: 'local' });
    });

    it('stays here when remote checks are off or queue checks stay on the Mac, and with no machine', () => {
      expect(route(specs, { AIO_REMOTE_CHECKS: 'off' })).toEqual({ kind: 'local' });
      expect(route(specs, {}, '/work/repo/.worktrees/queue/item-1')).toEqual({ kind: 'local' });
      expect(route(specs, {}, root, null)).toEqual({ kind: 'local' });
      expect(route(specs, { GITHUB_ACTIONS: 'true' })).toEqual({ kind: 'local' });
    });
  });

  it('treats a session working in a queue folder as a session', () => {
    expect(route([], { AIO_QUEUE_SESSION: '1' }, '/work/repo/.worktrees/queue/item-1')).toEqual({ kind: 'remote', turn: true });
  });
});

describe('isQueueCheck', () => {
  it.each([
    ['/r/.worktrees/queue/one', true],
    ['/r/.worktrees/base-gate-checks-1234', true],
    ['/r/.worktrees/combined-gate-checks-1234', true],
    ['/r/.worktrees/queue-quarantine/one', false],
    ['/r/.worktrees/loop-1', false],
    ['/r', false],
  ])('%s', (folder, expected) => {
    expect(isQueueCheck(folder, {})).toBe(expected);
  });
});

describe('isLoopRun', () => {
  it('knows a loop\'s agent and a loop\'s own verify step, which only has CI=1', () => {
    expect(isLoopRun({ ORCHESTRATOR_LOOP_CONTROL_FILE: '/tmp/control' })).toBe(true);
    expect(isLoopRun({ CI: '1' })).toBe(true);
    expect(isLoopRun({})).toBe(false);
  });
});

describe('readConfig', () => {
  it('reads nothing when the file is missing, and refuses a config with no host', () => {
    const dir = temp();
    expect(readConfig({ AIO_REMOTE_CHECKS_DIR: dir })).toBeNull();
    writeFileSync(join(dir, 'config.json'), '{}');
    expect(() => readConfig({ AIO_REMOTE_CHECKS_DIR: dir })).toThrow(/no host/);
  });

  it('takes work and runs three at once unless the file says otherwise, and ignores a slot count it cannot use', () => {
    const dir = temp();
    const first = () => readConfig({ AIO_REMOTE_CHECKS_DIR: dir })!.machines[0];
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ host: 'pc' }));
    expect(first()).toMatchObject({ paused: false, testRuns: true, checks: true, slots: 3, platform: 'linux' });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ host: 'pc', paused: true, testRuns: false, checks: false, slots: 5 }));
    expect(first()).toMatchObject({ paused: true, testRuns: false, checks: false, slots: 5 });
    for (const slots of [0, 9, 2.5, '4']) {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ host: 'pc', slots }));
      expect(first()).toMatchObject({ slots: 3 });
    }
  });

  it('reads the top-level machine first, then any more in their order', () => {
    const dir = temp();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ host: 'pc', label: 'the PC', queueChecks: true, nodeName: 'windows-pc' }));
    expect(readConfig({ AIO_REMOTE_CHECKS_DIR: dir })).toEqual({
      queueChecks: true,
      machines: [{ host: 'pc', label: 'the PC', nodeName: 'windows-pc', platform: 'linux', paused: false, testRuns: true, checks: true, slots: 3 }],
    });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      host: 'pc', label: 'the PC', moreMachines: [{ host: 'ct-test-mac', label: 'the test Mac', platform: 'darwin', slots: 2 }],
    }));
    expect(readConfig({ AIO_REMOTE_CHECKS_DIR: dir })!.machines.map(entry => [entry.host, entry.platform, entry.slots]))
      .toEqual([['pc', 'linux', 3], ['ct-test-mac', 'darwin', 2]]);
    for (const moreMachines of [['x'], [{ label: 'no host' }]]) {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ host: 'pc', moreMachines }));
      expect(() => readConfig({ AIO_REMOTE_CHECKS_DIR: dir })).toThrow();
    }
  });
});

describe('appendRunLog', () => {
  it('starts a new log past about a megabyte, keeping the one before', () => {
    const dir = temp();
    writeFileSync(join(dir, 'runs.jsonl'), `${'x'.repeat(1_000_001)}\n`);
    writeFileSync(join(dir, 'runs.old.jsonl'), 'oldest\n');
    const anHourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, 'runs.old.jsonl'), anHourAgo, anHourAgo);
    appendRunLog({ at: 'now' }, { AIO_REMOTE_CHECKS_DIR: dir });
    expect(readFileSync(join(dir, 'runs.jsonl'), 'utf8')).toBe('{"at":"now"}\n');
    expect(readFileSync(join(dir, 'runs.old.jsonl'), 'utf8').length).toBe(1_000_002);
    expect(Date.now() - statSync(join(dir, 'runs.old.jsonl')).mtimeMs).toBeLessThan(60_000);
    appendRunLog({ at: 'later' }, { AIO_REMOTE_CHECKS_DIR: dir });
    expect(readFileSync(join(dir, 'runs.jsonl'), 'utf8')).toBe('{"at":"now"}\n{"at":"later"}\n');
  });

  it('never moves a log started in the last minute, so two runs at once keep the history', () => {
    const dir = temp();
    writeFileSync(join(dir, 'runs.jsonl'), `${'x'.repeat(1_000_001)}\n`);
    writeFileSync(join(dir, 'runs.old.jsonl'), 'history\n');
    appendRunLog({ at: 'now' }, { AIO_REMOTE_CHECKS_DIR: dir });
    expect(readFileSync(join(dir, 'runs.old.jsonl'), 'utf8')).toBe('history\n');
  });

  it('adds one line per run', () => {
    const dir = temp();
    appendRunLog({ ranOn: 'a' }, { AIO_REMOTE_CHECKS_DIR: dir });
    appendRunLog({ ranOn: 'b' }, { AIO_REMOTE_CHECKS_DIR: dir });
    expect(readFileSync(join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).ranOn)).toEqual(['a', 'b']);
  });

  it('never stops a run when the log cannot be written', () => {
    const file = join(temp(), 'a-file');
    writeFileSync(file, '');
    expect(() => appendRunLog({}, { AIO_REMOTE_CHECKS_DIR: join(file, 'nested') })).not.toThrow();
  });
});

describe('takeMacTurn', () => {
  it('lets one run in at a time, and the next in once it is released', async () => {
    const dir = temp();
    const first = await takeMacTurn({ dir, isLoop: false, log: () => {} });
    expect(first.note).toBeNull();
    let secondHeld = false;
    const second = takeMacTurn({ dir, isLoop: false, log: () => {} }).then((turn) => {
      secondHeld = true;
      return turn;
    });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(secondHeld).toBe(false);
    first.release();
    const turn = await second;
    expect(turn.note).toBeNull();
    turn.release();
  });

  it('prints while it waits, then gives up and says so', async () => {
    const dir = temp();
    const holder = await takeMacTurn({ dir, isLoop: false, log: () => {} });
    const lines: string[] = [];
    const turn = await takeMacTurn({ dir, isLoop: false, log: line => lines.push(line), waitLimitMs: 300, noticeIntervalMs: 50 });
    expect(turn.note).toMatch(/stopped waiting/);
    expect(lines.length).toBeGreaterThan(0);
    holder.release();
  });

  it('runs anyway and says so when the lock cannot be taken', async () => {
    const file = join(temp(), 'a-file');
    writeFileSync(file, '');
    const turn = await takeMacTurn({ dir: join(file, 'nested'), isLoop: false, log: () => {} });
    expect(turn.note).toMatch(/could not be taken/);
  });
});

describe('MAC_ONLY_SPECS', () => {
  it('lists every spec with a macOS-only test, or that test would run nowhere after a run elsewhere', () => {
    const repoRoot = join(__dirname, '../..');
    const gated = /(?:runIf\(process\.platform === 'darwin'\)|skipIf\(process\.platform !== 'darwin'\))/;
    const specs = ['src', 'scripts', 'packages'].flatMap(top =>
      readdirSync(join(repoRoot, top), { recursive: true, encoding: 'utf8' })
        .filter(file => file.endsWith('.spec.ts') && !file.includes('node_modules'))
        .map(file => `${top}/${file}`));
    const needed = specs.filter(file => gated.test(readFileSync(join(repoRoot, file), 'utf8')));
    expect(needed.length).toBeGreaterThan(0);
    expect(needed.filter(file => !MAC_ONLY_SPECS.includes(file))).toEqual([]);
  });
});

describe('mergeMacOnlyReport', () => {
  const suite = (name: string, status: string) => ({
    name, status: status === 'failed' ? 'failed' : 'passed',
    assertionResults: [{ status, title: 't', fullName: `${name} t`, failureMessages: status === 'failed' ? ['boom'] : [] }],
  });
  const write = (file: string, testResults: unknown[]): void => writeFileSync(file, JSON.stringify({ numTotalTests: 2, testResults }));
  const setUp = () => {
    const dir = temp();
    const mainPath = join(dir, 'main.json');
    const macPath = join(dir, 'mac.json');
    write(mainPath, [suite('/r/a.spec.ts', 'passed'), suite('/r/mac.spec.ts', 'pending')]);
    return { mainPath, macPath };
  };

  it('replaces the far machine\'s skipped copy with the Mac\'s real result', () => {
    const { mainPath, macPath } = setUp();
    write(macPath, [suite('/r/mac.spec.ts', 'passed')]);
    mergeMacOnlyReport({ mainPath, macPath, root: '/r', macExitCode: 0 });
    const merged = JSON.parse(readFileSync(mainPath, 'utf8'));
    expect(merged).toMatchObject({ numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, success: true });
  });

  it('shows a Mac failure as a normal test failure', () => {
    const { mainPath, macPath } = setUp();
    write(macPath, [suite('/r/mac.spec.ts', 'failed')]);
    mergeMacOnlyReport({ mainPath, macPath, root: '/r', macExitCode: 1 });
    expect(JSON.parse(readFileSync(mainPath, 'utf8'))).toMatchObject({ numFailedTests: 1, success: false });
  });

  it('counts a Mac run with no report as a failure, not as nothing', () => {
    const { mainPath, macPath } = setUp();
    mergeMacOnlyReport({ mainPath, macPath, root: '/r', macExitCode: 7 });
    const merged = JSON.parse(readFileSync(mainPath, 'utf8'));
    expect(merged.numFailedTests).toBe(1);
    expect(JSON.stringify(merged.testResults)).toContain('exited 7');
  });
});
